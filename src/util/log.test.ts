import { describe, it, expect } from 'vitest';
import { logger } from '../util/log';

describe('logger', () => {
  it('should have logging methods', () => {
    expect(logger.debug).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
  });

  it('should call debug method without throwing', () => {
    expect(() => logger.debug('test message')).not.toThrow();
  });

  it('should call info method without throwing', () => {
    expect(() => logger.info('test message')).not.toThrow();
  });

  it('should call warn method without throwing', () => {
    expect(() => logger.warn('test message')).not.toThrow();
  });

  it('should call error method without throwing', () => {
    expect(() => logger.error('test message')).not.toThrow();
  });
});
