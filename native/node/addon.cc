// Node.js binding for the qpdf-node core, written against node-addon-api.
//
// Every operation returns a promise and does its PDF work on the libuv thread
// pool. Options are read and validated on the JavaScript thread first, so a bad
// call rejects without queueing any work. qpdf_node::Error is the only exception
// type that is thrown inside this file, and it is always caught in the same
// function that throws it: nothing propagates into N-API.
//
// Errors reject with an Error whose `code` is "INVALID_ARGUMENT" or
// "OPERATION_FAILED" (qpdf_node::ErrorKind).
#include <napi.h>

#include <cmath>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "file_operations.hh"
#include "pdf_core.hh"

namespace {

using qpdf_node::Bytes;
using qpdf_node::Document;
using qpdf_node::Error;
using qpdf_node::ErrorKind;

const char* codeFor(ErrorKind kind) {
  return kind == ErrorKind::InvalidArgument ? "INVALID_ARGUMENT" : "OPERATION_FAILED";
}

Napi::Value makeError(Napi::Env env, ErrorKind kind, const std::string& message) {
  Napi::Error error = Napi::Error::New(env, message);
  error.Value().Set("code", Napi::String::New(env, codeFor(kind)));
  return error.Value();
}

Napi::Promise rejectedPromise(Napi::Env env, const Error& error) {
  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Reject(makeError(env, error.kind(), error.what()));
  return deferred.Promise();
}

struct Nothing {};

// Runs `work` on the thread pool and settles a promise with `convert(result)`
// back on the JavaScript thread.
template <typename Result>
class PromiseWorker : public Napi::AsyncWorker {
 public:
  static Napi::Promise Start(
      Napi::Env env,
      std::function<Result()> work,
      std::function<Napi::Value(Napi::Env, Result&&)> convert) {
    auto* worker = new PromiseWorker(env, std::move(work), std::move(convert));
    Napi::Promise promise = worker->deferred_.Promise();
    worker->Queue();
    return promise;
  }

  // Runs on a pool thread. The work only throws qpdf_node::Error; anything else
  // is a bug, reported as a failure rather than allowed to terminate the process.
  void Execute() override {
    try {
      result_.emplace(work_());
    } catch (const Error& error) {
      kind_ = error.kind();
      SetError(error.what());
    } catch (...) {
      kind_ = ErrorKind::OperationFailed;
      SetError("unexpected failure inside the native core");
    }
  }

  void OnOK() override { deferred_.Resolve(convert_(Env(), std::move(*result_))); }

  void OnError(const Napi::Error& error) override {
    deferred_.Reject(makeError(Env(), kind_, error.Message()));
  }

 private:
  PromiseWorker(
      Napi::Env env,
      std::function<Result()> work,
      std::function<Napi::Value(Napi::Env, Result&&)> convert)
      : Napi::AsyncWorker(env),
        deferred_(Napi::Promise::Deferred::New(env)),
        work_(std::move(work)),
        convert_(std::move(convert)) {}

  Napi::Promise::Deferred deferred_;
  std::function<Result()> work_;
  std::function<Napi::Value(Napi::Env, Result&&)> convert_;
  std::optional<Result> result_;
  ErrorKind kind_ = ErrorKind::OperationFailed;
};

Napi::Value toUndefined(Napi::Env env, Nothing&&) { return env.Undefined(); }

Napi::Value toBuffer(Napi::Env env, Bytes&& bytes) {
  auto* owned = new Bytes(std::move(bytes));
  // The buffer owns `owned` until JavaScript garbage collects it. If the
  // runtime cannot hold external memory, NewOrCopy copies and frees at once.
  return Napi::Buffer<std::uint8_t>::NewOrCopy(
      env, owned->data(), owned->size(), [](Napi::Env, std::uint8_t*, Bytes* hint) { delete hint; }, owned);
}

// --- argument reading (throws Error(InvalidArgument) on bad input) ----------

[[noreturn]] void invalidArgument(const std::string& message) {
  throw Error(ErrorKind::InvalidArgument, message);
}

std::string describe(const Napi::Value& value) {
  if (value.IsNull()) return "null";
  if (value.IsArray()) return "array";
  if (value.IsUndefined()) return "undefined";
  if (value.IsString()) return "string";
  if (value.IsNumber()) return "number";
  return "object";
}

std::string readString(const Napi::Value& value, const std::string& label) {
  if (!value.IsString()) {
    invalidArgument(label + " must be a string. received=" + describe(value));
  }
  return value.As<Napi::String>().Utf8Value();
}

std::string readOptionalPassword(const Napi::Object& options, const std::string& label) {
  Napi::Value value = options.Get("password");
  if (value.IsUndefined()) {
    return "";
  }
  return readString(value, label);
}

std::uint32_t readPageNumber(const Napi::Value& value, const std::string& label) {
  if (!value.IsNumber()) {
    invalidArgument(label + " must be an integer. received=" + describe(value));
  }
  double number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || std::floor(number) != number || number < 1 || number > 4294967295.0) {
    invalidArgument(label + " must be an integer between 1 and 4294967295");
  }
  return static_cast<std::uint32_t>(number);
}

Napi::Object readObject(const Napi::Value& value, const std::string& label) {
  if (!value.IsObject() || value.IsArray()) {
    invalidArgument(label + " must be an object. received=" + describe(value));
  }
  return value.As<Napi::Object>();
}

// --- the opened document ------------------------------------------------------

using DocumentHandle = std::shared_ptr<Document>;

struct AddonState {
  Napi::FunctionReference documentConstructor;
};

// JavaScript view of a qpdf_node::Document. Created only by openDocument.
class NativeDocument : public Napi::ObjectWrap<NativeDocument> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
        env,
        "NativeDocument",
        {InstanceAccessor<&NativeDocument::PageCount>("pageCount"),
         InstanceMethod<&NativeDocument::Extract>("extract"),
         InstanceMethod<&NativeDocument::Close>("close")});
  }

  explicit NativeDocument(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeDocument>(info) {
    if (info.Length() != 1 || !info[0].IsExternal()) {
      Napi::TypeError::New(info.Env(), "NativeDocument cannot be constructed from JavaScript")
          .ThrowAsJavaScriptException();
      return;
    }
    document_ = *info[0].As<Napi::External<DocumentHandle>>().Data();
    page_count_ = document_->pageCount();
  }

 private:
  Napi::Value PageCount(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), page_count_);
  }

  // extract(pages: number[]): Promise<Buffer>
  Napi::Value Extract(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    try {
      if (!document_) {
        invalidArgument("extract called on a closed document");
      }
      if (info.Length() < 1 || !info[0].IsArray()) {
        invalidArgument("extract pages must be an array. received=" + (info.Length() < 1 ? std::string("undefined") : describe(info[0])));
      }
      Napi::Array array = info[0].As<Napi::Array>();
      std::vector<std::uint32_t> pages;
      for (std::uint32_t index = 0; index < array.Length(); ++index) {
        pages.push_back(readPageNumber(array.Get(index), "extract pages[" + std::to_string(index) + "]"));
      }
      DocumentHandle document = document_;  // keeps the document alive even if closed meanwhile
      return PromiseWorker<Bytes>::Start(
          env, [document, pages] { return document->extractPages(pages); }, toBuffer);
    } catch (const Error& error) {
      return rejectedPromise(env, error);
    }
  }

  // Releases this view's reference. Extractions already started keep the
  // document alive until they finish; its memory is freed after the last one.
  Napi::Value Close(const Napi::CallbackInfo& info) {
    document_.reset();
    return info.Env().Undefined();
  }

  DocumentHandle document_;
  std::uint32_t page_count_ = 0;
};

// openDocument(bytes: Uint8Array, password?: string): Promise<NativeDocument>
Napi::Value OpenDocument(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    if (info.Length() < 1 || !info[0].IsTypedArray() ||
        info[0].As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
      invalidArgument("openDocument input must be a Uint8Array. received=" + (info.Length() < 1 ? std::string("undefined") : describe(info[0])));
    }
    // The caller may reuse its buffer as soon as this call returns, so copy now.
    Napi::Uint8Array input = info[0].As<Napi::Uint8Array>();
    Bytes bytes(input.Data(), input.Data() + input.ByteLength());
    std::string password;
    if (info.Length() >= 2 && !info[1].IsUndefined()) {
      password = readString(info[1], "openDocument password");
    }
    return PromiseWorker<DocumentHandle>::Start(
        env,
        [bytes = std::move(bytes), password]() mutable {
          return Document::openMemory(std::move(bytes), password);
        },
        [](Napi::Env env, DocumentHandle&& document) -> Napi::Value {
          auto* state = env.GetInstanceData<AddonState>();
          auto* handle = new DocumentHandle(std::move(document));
          auto external = Napi::External<DocumentHandle>::New(
              env, handle, [](Napi::Env, DocumentHandle* data) { delete data; });
          return state->documentConstructor.New({external});
        });
  } catch (const Error& error) {
    return rejectedPromise(env, error);
  }
}

// --- path-based operations --------------------------------------------------

qpdf_node::MergeRequest readMergeRequest(const Napi::Value& value) {
  Napi::Object options = readObject(value, "merge options");
  Napi::Value inputs = options.Get("inputs");
  if (!inputs.IsArray()) {
    invalidArgument("merge options.inputs must be an array. received=" + describe(inputs));
  }
  qpdf_node::MergeRequest request;
  Napi::Array array = inputs.As<Napi::Array>();
  for (std::uint32_t index = 0; index < array.Length(); ++index) {
    std::string label = "merge options.inputs[" + std::to_string(index) + "]";
    Napi::Object input = readObject(array.Get(index), label);
    qpdf_node::MergeInput merge_input;
    merge_input.path = readString(input.Get("path"), label + ".path");
    Napi::Value pages = input.Get("pages");
    if (!pages.IsUndefined()) {
      std::string text = readString(pages, label + ".pages");
      try {
        merge_input.pages = qpdf_node::PageRange::parse(text);
      } catch (const Error& cause) {
        invalidArgument(label + ".pages is not a valid page range: " + cause.what());
      }
    }
    request.inputs.push_back(std::move(merge_input));
  }
  request.output = readString(options.Get("output"), "merge options.output");
  request.password = readOptionalPassword(options, "merge options.password");
  qpdf_node::validate(request);
  return request;
}

qpdf_node::SplitPagesRequest readSplitPagesRequest(const Napi::Value& value) {
  Napi::Object options = readObject(value, "splitPages options");
  qpdf_node::SplitPagesRequest request;
  request.input = readString(options.Get("input"), "splitPages options.input");
  request.output_pattern = readString(options.Get("outputPattern"), "splitPages options.outputPattern");
  Napi::Value pages_per_file = options.Get("pagesPerFile");
  if (!pages_per_file.IsUndefined()) {
    request.pages_per_file = readPageNumber(pages_per_file, "splitPages options.pagesPerFile");
  }
  request.password = readOptionalPassword(options, "splitPages options.password");
  qpdf_node::validate(request);
  return request;
}

Napi::Value MergeNative(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    auto request = std::make_shared<qpdf_node::MergeRequest>(readMergeRequest(info[0]));
    return PromiseWorker<Nothing>::Start(
        env,
        [request] {
          qpdf_node::merge(*request);
          return Nothing{};
        },
        toUndefined);
  } catch (const Error& error) {
    return rejectedPromise(env, error);
  }
}

Napi::Value SplitPagesNative(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    auto request = std::make_shared<qpdf_node::SplitPagesRequest>(readSplitPagesRequest(info[0]));
    return PromiseWorker<Nothing>::Start(
        env,
        [request] {
          qpdf_node::splitPages(*request);
          return Nothing{};
        },
        toUndefined);
  } catch (const Error& error) {
    return rejectedPromise(env, error);
  }
}

Napi::Value PageCountNative(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    Napi::Object options = readObject(info[0], "pageCount options");
    std::string input = readString(options.Get("input"), "pageCount options.input");
    std::string password = readOptionalPassword(options, "pageCount options.password");
    return PromiseWorker<std::uint32_t>::Start(
        env,
        [input, password] { return qpdf_node::pageCount(input, password); },
        [](Napi::Env env, std::uint32_t&& count) -> Napi::Value { return Napi::Number::New(env, count); });
  } catch (const Error& error) {
    return rejectedPromise(env, error);
  }
}

Napi::Value QpdfVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), qpdf_node::qpdfVersion());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  auto* state = new AddonState();
  state->documentConstructor = Napi::Persistent(NativeDocument::Define(env));
  env.SetInstanceData(state);

  exports.Set("openDocument", Napi::Function::New(env, OpenDocument, "openDocument"));
  exports.Set("mergeNative", Napi::Function::New(env, MergeNative, "mergeNative"));
  exports.Set("splitPagesNative", Napi::Function::New(env, SplitPagesNative, "splitPagesNative"));
  exports.Set("pageCountNative", Napi::Function::New(env, PageCountNative, "pageCountNative"));
  exports.Set("qpdfVersion", Napi::Function::New(env, QpdfVersion, "qpdfVersion"));
  return exports;
}

}  // namespace

NODE_API_MODULE(qpdf_node, Init)
