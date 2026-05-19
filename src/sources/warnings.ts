import { Chain, SourceWarning, SourceWarningCode } from '../adapters/types.js';

interface AdapterError {
  code: string;
  message?: string;
}

function mapErrorCode(code: string): SourceWarningCode {
  if (code === SourceWarningCode.RealSourceNotImplemented) {
    return SourceWarningCode.RealSourceNotImplemented;
  }
  if (code === SourceWarningCode.SourceTermsBlocked) {
    return SourceWarningCode.SourceTermsBlocked;
  }
  if (code === SourceWarningCode.SourceParseFailed) {
    return SourceWarningCode.SourceParseFailed;
  }
  if (code === SourceWarningCode.SourceRateLimited || code === 'HTTP_429') {
    return SourceWarningCode.SourceRateLimited;
  }
  return SourceWarningCode.SourceUnavailable;
}

export function sourceWarningFromError(chain: Chain, error: AdapterError): SourceWarning {
  const code = mapErrorCode(error.code);
  return {
    chain,
    code,
    message: error.message ?? `${chain} source failed with ${error.code}.`,
    observedAt: new Date().toISOString(),
  };
}

export function notImplementedWarning(chain: Chain, capability: string): SourceWarning {
  return {
    chain,
    code: SourceWarningCode.RealSourceNotImplemented,
    message: `${capability} is not backed by a real source for ${chain} yet.`,
    observedAt: new Date().toISOString(),
  };
}
