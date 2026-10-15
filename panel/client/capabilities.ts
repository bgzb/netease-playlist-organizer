import type {CapabilityReport} from '../core/model';
import {createWriteApi,type WriteFactory} from './requests';
import {discoverClientParts,type WebpackRequire} from './read-capabilities';
export {ADAPTER_VERSION,discoverReadClient,type WebpackRequire} from './read-capabilities';
let pageReport:CapabilityReport|undefined;
/** Product discovery preserves the existing read/write capability contract. */
export function discoverClient(requireOverride?:WebpackRequire):CapabilityReport {
  if(!requireOverride&&pageReport)return pageReport;
  const {report,factory}=discoverClientParts(requireOverride);
  const result=report.supported&&factory?{...report,write:createWriteApi(factory as unknown as WriteFactory)}:report;
  if(!requireOverride&&result.supported)pageReport=result;
  return result;
}
