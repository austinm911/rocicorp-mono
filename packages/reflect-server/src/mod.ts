import {DatadogLogSink} from 'datadog';
import {REPORT_METRICS_PATH} from './server/paths.js';

export {
  TeeLogSink,
  consoleLogSink,
  type LogLevel,
  type LogSink,
} from '@rocicorp/logger';
export type {AuthHandler} from './server/auth.js';
export type {DisconnectHandler} from './server/disconnect.js';
export {
  ReflectServerBaseEnv,
  ReflectServerOptions,
  createReflectServer,
} from './server/reflect.js';
export const ROUTES = {
  reportMetrics: REPORT_METRICS_PATH,
};
export {createDatadogMetricsSink} from './server/datadog-metrics-sink.js';

export type WorkerDatadogLogSinkOptions = {
  apiKey: string;
  service?: string | undefined;
  host?: string | undefined;
};
export function createWorkerDatadogLogSink(opts: WorkerDatadogLogSinkOptions) {
  return new DatadogLogSink({...opts, source: 'worker'});
}

// TODO(arv): Only export the types that are actually used.
// https://github.com/rocicorp/mono/issues/362
export * from 'replicache';

export type {
  AuthData,
  MutatorDefs,
  ReadTransaction,
  WriteTransaction,
} from 'reflect-types';

export {version} from './util/version.js';
