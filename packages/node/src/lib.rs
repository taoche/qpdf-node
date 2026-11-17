//! Node.js binding for `pdq-core`.
//!
//! Each exported function returns a promise. The pdq work runs in a `Task` on
//! the libuv thread pool, so it never blocks the JavaScript event loop.
//! `packages/node/src/index.ts` is the public API; these functions are its
//! native layer and are not meant to be called directly.

use std::path::PathBuf;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Status, Task};
use napi_derive::napi;

fn to_napi_error(error: pdq_core::Error) -> napi::Error {
    let status = match error {
        pdq_core::Error::InvalidRequest(_) => Status::InvalidArg,
        pdq_core::Error::Operation { .. } => Status::GenericFailure,
    };
    napi::Error::new(status, error.to_string())
}

#[napi(object)]
pub struct NativeMergeInput {
    pub path: String,
    pub pages: Option<String>,
}

#[napi(object)]
pub struct NativeMergeOptions {
    pub inputs: Vec<NativeMergeInput>,
    pub output: String,
    pub password: Option<String>,
}

#[napi(object)]
pub struct NativeSplitPagesOptions {
    pub input: String,
    pub output_pattern: String,
    pub pages_per_file: Option<u32>,
    pub password: Option<String>,
}

#[napi(object)]
pub struct NativePageCountOptions {
    pub input: String,
    pub password: Option<String>,
}

pub struct MergeTask {
    request: pdq_core::MergeRequest,
}

impl Task for MergeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        pdq_core::merge(&self.request).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

pub struct SplitPagesTask {
    request: pdq_core::SplitPagesRequest,
}

impl Task for SplitPagesTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        pdq_core::split_pages(&self.request).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

pub struct PageCountTask {
    request: pdq_core::PageCountRequest,
}

impl Task for PageCountTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        pdq_core::page_count(&self.request).map_err(to_napi_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "mergeNative", ts_return_type = "Promise<void>")]
pub fn merge_native(options: NativeMergeOptions) -> AsyncTask<MergeTask> {
    let inputs = options
        .inputs
        .into_iter()
        .map(|input| pdq_core::MergeInput {
            path: PathBuf::from(input.path),
            pages: input.pages,
        })
        .collect();
    AsyncTask::new(MergeTask {
        request: pdq_core::MergeRequest {
            inputs,
            output: PathBuf::from(options.output),
            password: options.password,
        },
    })
}

#[napi(js_name = "splitPagesNative", ts_return_type = "Promise<void>")]
pub fn split_pages_native(options: NativeSplitPagesOptions) -> AsyncTask<SplitPagesTask> {
    AsyncTask::new(SplitPagesTask {
        request: pdq_core::SplitPagesRequest {
            input: PathBuf::from(options.input),
            output_pattern: options.output_pattern,
            pages_per_file: options.pages_per_file,
            password: options.password,
        },
    })
}

#[napi(js_name = "pageCountNative", ts_return_type = "Promise<number>")]
pub fn page_count_native(options: NativePageCountOptions) -> AsyncTask<PageCountTask> {
    AsyncTask::new(PageCountTask {
        request: pdq_core::PageCountRequest {
            input: PathBuf::from(options.input),
            password: options.password,
        },
    })
}
