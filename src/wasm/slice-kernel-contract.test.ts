import { describe, expect, it, vi } from 'vitest';

import * as contractModule from './slice-kernel-contract';
import * as loaderModule from './load-slice-kernel';
import {
  CanonicalFallbackGuard,
  SliceKernelError,
  parseSliceBatchResult as parseResult,
  readSliceKernelAbort,
  validateSliceBatchRequest as validateRequest,
  type SliceBatchRequest,
} from './slice-kernel-contract';

const RESULT_VERSION = 1;
const STATUS_OK = 0;
const DIAGNOSTIC_COUNTER_COUNT = 9;
const continueCheckpoint = (): undefined => undefined;

function parseSliceBatchResult(value: unknown, activeRequest: SliceBatchRequest) {
  return parseResult(value, activeRequest, continueCheckpoint);
}

function validateSliceBatchRequest(value: unknown) {
  return validateRequest(value, continueCheckpoint);
}

function request(overrides: Partial<SliceBatchRequest> = {}): SliceBatchRequest {
  return {
    positions: new Float32Array([
      0, 0, -1,
      2, 0, 1,
      0, 2, 1,
    ]),
    indices: new Uint32Array([0, 1, 2]),
    planes: new Float64Array([0]),
    deadlineCheckInterval: 4_096,
    ...overrides,
  };
}

function encodedResult(overrides: Partial<{
  version: unknown;
  statusCode: unknown;
  planeOffsets: unknown;
  endpoints: unknown;
  diagnosticCounters: unknown;
}> = {}): unknown {
  const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
  diagnosticCounters[3] = 1;
  diagnosticCounters[4] = 1;
  return {
    version: RESULT_VERSION,
    statusCode: STATUS_OK,
    planeOffsets: new Uint32Array([0, 1]),
    endpoints: new Float64Array([0, 0, 1, 1]),
    diagnosticCounters,
    ...overrides,
  };
}

function emptyEncodedResult(): unknown {
  const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
  diagnosticCounters[3] = 1;
  return encodedResult({
    planeOffsets: new Uint32Array([0, 0]),
    endpoints: new Float64Array(0),
    diagnosticCounters,
  });
}

function expectKernelCode(action: () => unknown, code: SliceKernelError['code']): void {
  expect(action).toThrowError(expect.objectContaining({ name: 'SliceKernelError', code }));
}

function captureFailure(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected action to fail');
}

function ordinaryInvalidResultFailure(): unknown {
  return captureFailure(
    () => parseSliceBatchResult(encodedResult({ version: 2 }), request()),
  );
}

function expectValidationAndFallbackDenied(
  action: () => unknown,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
): void {
  const error = captureFailure(action);
  expect(error).toMatchObject({ name: 'SliceKernelError', code });
  expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
    expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
  );
}

const hostileRecordCases = [
  ['revoked', <T extends object>(target: T): T => {
    const pair = Proxy.revocable(target, {});
    pair.revoke();
    return pair.proxy;
  }],
  ['prototype trap', <T extends object>(target: T): T => new Proxy(target, {
    getPrototypeOf: () => { throw new Error('private prototype detail'); },
  })],
  ['ownKeys trap', <T extends object>(target: T): T => new Proxy(target, {
    ownKeys: () => { throw new Error('private ownKeys detail'); },
  })],
  ['descriptor trap', <T extends object>(target: T): T => new Proxy(target, {
    getOwnPropertyDescriptor: () => { throw new Error('private descriptor detail'); },
  })],
] as const;

function withThrowingOwnProperty<T extends object>(target: T, key: PropertyKey): T {
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => { throw new Error(`private ${String(key)} detail`); },
  });
  return target;
}

function detachedView<T extends Float32Array | Uint32Array>(view: T): T {
  structuredClone(view.buffer, { transfer: [view.buffer] });
  return view;
}

function resizableView<T extends Float32Array | Float64Array | Uint32Array>(
  constructor: { new(buffer: ArrayBuffer): T; readonly BYTES_PER_ELEMENT: number },
  length: number,
): T {
  const ResizableArrayBuffer = ArrayBuffer as unknown as {
    new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
  };
  return new constructor(new ResizableArrayBuffer(
    length * constructor.BYTES_PER_ELEMENT,
    { maxByteLength: (length + 1) * constructor.BYTES_PER_ELEMENT },
  ));
}

describe('TypeScript WASM slice contract', () => {
  it('rejects malformed result versions and statuses', () => {
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ version: 2 }), request()),
      'INVALID_RESULT',
    );
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ statusCode: 2 }), request()),
      'INVALID_RESULT',
    );
  });

  it.each([
    new Uint32Array([1, 1]),
    new Uint32Array([0, 2]),
    new Uint32Array([0, 1, 0]),
  ])('rejects malformed and extra plane offsets %#', (planeOffsets) => {
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ planeOffsets }), request()),
      'INVALID_RESULT',
    );
  });

  it('rejects an endpoint length that cannot encode complete segments', () => {
    expectKernelCode(
      () => parseSliceBatchResult(
        encodedResult({ endpoints: new Float64Array([0, 0, 1]) }),
        request(),
      ),
      'INVALID_RESULT',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-finite endpoint %s',
    (value) => {
      expectKernelCode(
        () => parseSliceBatchResult(
          encodedResult({ endpoints: new Float64Array([0, 0, 1, value]) }),
          request(),
        ),
        'INVALID_RESULT',
      );
    },
  );

  it('rejects diagnostic counters that exceed request-derived limits', () => {
    const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
    diagnosticCounters[3] = 0xffff_ffff;
    diagnosticCounters[4] = 1;
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ diagnosticCounters }), request()),
      'INVALID_RESULT',
    );
  });

  it('rejects typed-array allocation lengths above the approved hard caps', () => {
    const oversizedEndpoints = new Float64Array((8 * 1024 * 1024 / 8) + 1);
    let checkpointCount = 0;
    const error = captureFailure(
      () => parseResult(
        encodedResult({ endpoints: oversizedEndpoints }),
        request(),
        () => {
          checkpointCount += 1;
          return undefined;
        },
      ),
    );
    expect(error).toMatchObject({ name: 'SliceKernelError', code: 'RESOURCE_LIMIT' });
    expect(checkpointCount).toBe(0);
    expect(new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toBeDefined();
  });

  it.each([
    ['positions', new Float64Array(3)],
    ['indices', new Int32Array(3)],
    ['planes', new Float32Array(1)],
  ] as const)('rejects the wrong %s typed array before WASM', (key, value) => {
    expectKernelCode(
      () => validateSliceBatchRequest({ ...request(), [key]: value } as unknown),
      'INVALID_REQUEST',
    );
  });

  it.each([
    ['planeOffsets', new Int32Array([0, 1])],
    ['endpoints', new Float32Array([0, 0, 1, 1])],
    ['diagnosticCounters', new BigUint64Array(DIAGNOSTIC_COUNTER_COUNT)],
  ] as const)('rejects the wrong result %s typed array', (key, value) => {
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ [key]: value }), request()),
      'INVALID_RESULT',
    );
  });

  it('uses strict schemas that reject unrecognized request and result fields', () => {
    expectKernelCode(
      () => validateSliceBatchRequest({ ...request(), unexpected: true }),
      'INVALID_REQUEST',
    );
    expectKernelCode(
      () => parseSliceBatchResult(
        { ...(encodedResult() as object), unexpected: true },
        request(),
      ),
      'INVALID_RESULT',
    );
  });

  it('rejects hidden strings, symbols, and unexpected accessors via Reflect.ownKeys', () => {
    const hiddenRequest = request() as SliceBatchRequest & Record<PropertyKey, unknown>;
    Object.defineProperty(hiddenRequest, 'hidden', { value: true, enumerable: false });
    expectKernelCode(() => validateSliceBatchRequest(hiddenRequest), 'INVALID_REQUEST');

    const symbolResult = encodedResult() as Record<PropertyKey, unknown>;
    symbolResult[Symbol('extra')] = true;
    expectKernelCode(() => parseSliceBatchResult(symbolResult, request()), 'INVALID_RESULT');

    const accessorResult = encodedResult() as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorResult, 'unexpectedAccessor', {
      configurable: true,
      get: () => true,
    });
    expectKernelCode(() => parseSliceBatchResult(accessorResult, request()), 'INVALID_RESULT');
  });

  it.each(hostileRecordCases)(
    'fails closed for direct request/result strict-record %s and denies fallback',
    (_name, wrap) => {
      expectValidationAndFallbackDenied(
        () => validateSliceBatchRequest(wrap(request())),
        'INVALID_REQUEST',
      );
      expectValidationAndFallbackDenied(
        () => parseSliceBatchResult(wrap(encodedResult() as object), request()),
        'INVALID_RESULT',
      );
    },
  );

  it('uses verified record descriptor values without invoking hostile get traps', () => {
    const requestProxy = new Proxy(request(), {
      get: () => { throw new Error('ordinary request get must not run'); },
    });
    expect(() => validateSliceBatchRequest(requestProxy)).not.toThrow();

    const resultProxy = new Proxy(encodedResult() as object, {
      get: () => { throw new Error('ordinary result get must not run'); },
    });
    expect(parseSliceBatchResult(resultProxy, request())).toMatchObject({ version: RESULT_VERSION });
  });

  it.each([
    ['Proxy-wrapped', () => new Proxy(new Float32Array([0, 0, 0]), {})],
    ['own constructor', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'constructor')],
    ['own buffer', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'buffer')],
    ['own length', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'length')],
    ['detached', () => detachedView(new Float32Array([0, 0, 0]))],
    ['shared backing buffer', () => new Float32Array(new SharedArrayBuffer(12))],
    ['non-zero offset', () => new Float32Array(new ArrayBuffer(16), 4, 3)],
    ['partial backing buffer', () => new Float32Array(new ArrayBuffer(16), 0, 3)],
  ] as const)('rejects %s request typed arrays with INVALID_REQUEST and no fallback', (_name, value) => {
    expectValidationAndFallbackDenied(
      () => validateSliceBatchRequest(request({ positions: value() as Float32Array })),
      'INVALID_REQUEST',
    );
  });

  it.each([
    ['Proxy-wrapped', () => new Proxy(new Uint32Array([0, 1]), {})],
    ['own constructor', () => withThrowingOwnProperty(new Uint32Array([0, 1]), 'constructor')],
    ['own buffer', () => withThrowingOwnProperty(new Uint32Array([0, 1]), 'buffer')],
    ['own length', () => withThrowingOwnProperty(new Uint32Array([0, 1]), 'length')],
    ['detached', () => detachedView(new Uint32Array([0, 1]))],
    ['shared backing buffer', () => new Uint32Array(new SharedArrayBuffer(8))],
    ['non-zero offset', () => new Uint32Array(new ArrayBuffer(12), 4, 2)],
    ['partial backing buffer', () => new Uint32Array(new ArrayBuffer(12), 0, 2)],
    ['misaligned spoof', () => {
      const fake = Object.create(Uint32Array.prototype);
      Object.defineProperties(fake, {
        buffer: { value: new ArrayBuffer(8) },
        byteOffset: { value: 2 },
        byteLength: { value: 8 },
        length: { value: 2 },
        constructor: { value: Uint32Array },
      });
      return fake;
    }],
  ] as const)('rejects %s result typed arrays with INVALID_RESULT and no fallback', (_name, value) => {
    expectValidationAndFallbackDenied(
      () => parseSliceBatchResult(encodedResult({ planeOffsets: value() }), request()),
      'INVALID_RESULT',
    );
  });

  it('rejects unsafe request counts and malformed finite/index data before WASM', () => {
    expectKernelCode(
      () => validateSliceBatchRequest(request({ deadlineCheckInterval: Number.MAX_SAFE_INTEGER + 1 })),
      'INVALID_REQUEST',
    );
    expectKernelCode(
      () => validateSliceBatchRequest(request({ positions: new Float32Array([0, 0, Number.NaN]) })),
      'INVALID_REQUEST',
    );
    expectKernelCode(
      () => validateSliceBatchRequest(request({ indices: new Uint32Array([0, 1, 3]) })),
      'INVALID_REQUEST',
    );
  });

  it('accepts only exact reason/source abort records at the public adapter boundary', () => {
    expect(readSliceKernelAbort(() => ({ reason: 'cancelled', source: 'user' })))
      .toEqual({ reason: 'cancelled', source: 'user' });
    expect(readSliceKernelAbort(() => ({ reason: 'deadline', source: 'runtime-deadline' })))
      .toEqual({ reason: 'deadline', source: 'runtime-deadline' });
    expectKernelCode(() => readSliceKernelAbort(() => false as never), 'DEADLINE_CHECK_FAILED');
    expectKernelCode(
      () => readSliceKernelAbort(
        () => ({ reason: 'cancelled', source: 'runtime-deadline' } as never),
      ),
      'DEADLINE_CHECK_FAILED',
    );
  });

  it('returns a frozen public record over controlled-wrapper owned typed arrays', () => {
    const parsed = parseSliceBatchResult(encodedResult(), request());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Array.from(parsed.planeOffsets)).toEqual([0, 1]);
    expect(Array.from(parsed.endpoints)).toEqual([0, 0, 1, 1]);
    expect(parsed.diagnosticCounters.at(4)).toBe(1);
  });

  it('implements Array.prototype.at ToIntegerOrInfinity semantics', () => {
    const parsed = parseSliceBatchResult(encodedResult(), request());
    expect(parsed.endpoints.at(1.9)).toBe(0);
    expect(parsed.endpoints.at(-1.9)).toBe(1);
    expect(parsed.endpoints.at(-0.9)).toBe(0);
    expect(parsed.endpoints.at(Number.NaN)).toBe(0);
    expect(parsed.endpoints.at(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parsed.endpoints.at(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(parsed.endpoints.at(4)).toBeUndefined();
    expect(parsed.endpoints.at(-5)).toBeUndefined();
  });

  it.each([
    ['overwrite at', (prototype: object) => Object.defineProperty(prototype, 'at', {
      configurable: true,
      value: () => 99,
    })],
    ['delete iterator', (prototype: object) => {
      if (!Reflect.deleteProperty(prototype, Symbol.iterator)) throw new TypeError('delete failed');
    }],
    ['replace prototype chain', (prototype: object) => Object.setPrototypeOf(prototype, {})],
  ] as const)(
    'freezes the shared result prototype against %s for existing and future values',
    (_label, mutate) => {
      const existing = parseSliceBatchResult(encodedResult(), request());
      const prototype = Object.getPrototypeOf(existing.endpoints) as object;
      expect(Object.isFrozen(prototype)).toBe(true);
      expect(() => mutate(prototype)).toThrow(TypeError);
      expect(Array.from(existing.endpoints)).toEqual([0, 0, 1, 1]);
      expect(existing.endpoints.at(-1)).toBe(1);

      const future = parseSliceBatchResult(encodedResult(), request());
      expect(Array.from(future.endpoints)).toEqual([0, 0, 1, 1]);
      expect(future.endpoints.at(-1)).toBe(1);
    },
  );

  it('prevents index, set, and fill mutation of validated public values', () => {
    const parsed = parseSliceBatchResult(encodedResult(), request());
    const publicOffsets = parsed.planeOffsets as unknown as Uint32Array;

    expect(() => { publicOffsets[0] = 99; }).toThrow(TypeError);
    expect(() => publicOffsets.set(new Uint32Array([99]), 0)).toThrow(TypeError);
    expect(() => publicOffsets.fill(99)).toThrow(TypeError);
    expect(Array.from(parsed.planeOffsets)).toEqual([0, 1]);
  });

  it.each(['LOAD_FAILED', 'EXECUTION_FAILED', 'INVALID_RESULT', 'RESOURCE_LIMIT'] as const)(
    'never lets public construction mint fallback provenance for %s',
    (code) => {
      const forgedDefault = new SliceKernelError(code, 'forged public error');
      const forgedExplicit = new SliceKernelError(
        code,
        'forged public error',
        undefined,
        true,
      );
      expect(forgedDefault.fallbackEligible).toBe(false);
      expect(forgedExplicit.fallbackEligible).toBe(false);
      expectKernelCode(
        () => new CanonicalFallbackGuard().claimTypeScriptFallback(forgedDefault),
        'FALLBACK_NOT_ALLOWED',
      );
      expectKernelCode(
        () => new CanonicalFallbackGuard().claimTypeScriptFallback(forgedExplicit),
        'FALLBACK_NOT_ALLOWED',
      );
    },
  );

  it('denies fallback provenance to public SliceKernelError subclasses', () => {
    class ForgedSliceKernelError extends SliceKernelError {}
    const forged = new ForgedSliceKernelError('LOAD_FAILED', 'forged subclass');
    expect(forged.fallbackEligible).toBe(false);
    expectKernelCode(
      () => new CanonicalFallbackGuard().claimTypeScriptFallback(forged),
      'FALLBACK_NOT_ALLOWED',
    );
  });

  it('atomically transfers request ownership before the first untrusted checkpoint', () => {
    const source = request();
    const callerViews = [source.positions, source.indices, source.planes] as const;
    let checkpointCount = 0;

    expect(() => validateRequest(source, () => {
      checkpointCount += 1;
      for (const view of callerViews) {
        expect(view.byteLength).toBe(0);
        try { view[0] = Number.NaN; } catch { /* detached writes may throw */ }
      }
      return undefined;
    })).not.toThrow();

    expect(checkpointCount).toBeGreaterThan(0);
    expect(callerViews.map((view) => view.byteLength)).toEqual([0, 0, 0]);
  });

  it('rejects request arrays that share one backing buffer before any transfer or checkpoint', () => {
    const shared = new ArrayBuffer(72);
    const source = request({
      positions: new Float32Array(shared),
      indices: new Uint32Array(shared),
      planes: new Float64Array(shared),
    });
    let checkpointCount = 0;
    expectValidationAndFallbackDenied(() => validateRequest(source, () => {
      checkpointCount += 1;
      return undefined;
    }), 'INVALID_REQUEST');
    expect(checkpointCount).toBe(0);
    expect(shared.byteLength).toBe(72);
  });

  it('maps ownership-transfer failure to typed INVALID_REQUEST without fallback', async () => {
    vi.resetModules();
    const originalStructuredClone = globalThis.structuredClone;
    vi.stubGlobal('structuredClone', () => { throw new DOMException('private', 'DataCloneError'); });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      const error = captureFailure(() => isolated.validateSliceBatchRequest(
        source,
        continueCheckpoint,
      ));
      expect(error).toMatchObject({
        name: 'SliceKernelError',
        code: 'INVALID_REQUEST',
        fallbackEligible: false,
      });
      expect(() => new isolated.CanonicalFallbackGuard().claimTypeScriptFallback(error))
        .toThrowError(expect.objectContaining({
          name: 'SliceKernelError',
          code: 'FALLBACK_NOT_ALLOWED',
        }));
      expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
        .toEqual([36, 12, 8]);
    } finally {
      vi.unstubAllGlobals();
      expect(globalThis.structuredClone).toBe(originalStructuredClone);
      vi.resetModules();
    }
  });

  it.each([
    ['returns caller buffers without detaching them', (
      _nativeClone: typeof structuredClone,
      buffers: ArrayBuffer[],
    ) => buffers],
    ['returns new buffers but leaves caller buffers attached', (
      _nativeClone: typeof structuredClone,
      buffers: ArrayBuffer[],
    ) => buffers.map((buffer) => buffer.slice(0))],
  ] as const)(
    'rejects a fake-success structuredClone that %s',
    async (_label, fakeClone) => {
      vi.resetModules();
      const nativeClone = globalThis.structuredClone;
      vi.stubGlobal('structuredClone', (buffers: ArrayBuffer[]) => fakeClone(nativeClone, buffers));
      try {
        const isolated = await import('./slice-kernel-contract');
        const source = request();
        let checkpointCount = 0;
        const error = captureFailure(() => isolated.validateSliceBatchRequest(source, () => {
          checkpointCount += 1;
          return undefined;
        }));
        expect(error).toMatchObject({
          name: 'SliceKernelError',
          code: 'INVALID_REQUEST',
          fallbackEligible: false,
        });
        expect(checkpointCount).toBe(0);
        expect(() => new isolated.CanonicalFallbackGuard().claimTypeScriptFallback(error))
          .toThrowError(expect.objectContaining({ code: 'FALLBACK_NOT_ALLOWED' }));
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );

  it('rejects aliased private buffers returned after a real detach', async () => {
    vi.resetModules();
    const nativeClone = globalThis.structuredClone;
    vi.stubGlobal('structuredClone', (
      buffers: ArrayBuffer[],
      options: StructuredSerializeOptions,
    ) => {
      const privateBuffers = nativeClone(buffers, options);
      return [privateBuffers[0], privateBuffers[0], privateBuffers[2]];
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const positionBuffer = new ArrayBuffer(36);
      const indexBuffer = new ArrayBuffer(36);
      const pattern = [0, 1, 2, 0, 1, 2, 0, 1, 2];
      new Uint32Array(positionBuffer).set(pattern);
      new Uint32Array(indexBuffer).set(pattern);
      const source = request({
        positions: new Float32Array(positionBuffer),
        indices: new Uint32Array(indexBuffer),
      });
      let checkpointCount = 0;
      const error = captureFailure(() => isolated.validateSliceBatchRequest(source, () => {
        checkpointCount += 1;
        return undefined;
      }));
      expect(error).toMatchObject({
        name: 'SliceKernelError',
        code: 'INVALID_REQUEST',
        fallbackEligible: false,
      });
      expect(checkpointCount).toBe(0);
      expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
        .toEqual([0, 0, 0]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('checks original preflight buffers when a fake clone rewrites its transport', async () => {
    vi.resetModules();
    const nativeClone = globalThis.structuredClone;
    vi.stubGlobal('structuredClone', (buffers: ArrayBuffer[]) => {
      const privateBuffers = buffers.map((buffer) => buffer.slice(0));
      const detachedDecoys = buffers.map(() => new ArrayBuffer(0));
      nativeClone(detachedDecoys, { transfer: detachedDecoys });
      for (let index = 0; index < buffers.length; index += 1) {
        Object.defineProperty(buffers, String(index), {
          configurable: true,
          enumerable: true,
          value: detachedDecoys[index],
          writable: true,
        });
      }
      return privateBuffers;
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      const callerViews = [source.positions, source.indices, source.planes] as const;
      const error = captureFailure(() => isolated.validateSliceBatchRequest(
        source,
        continueCheckpoint,
      ));
      expect(error).toMatchObject({
        name: 'SliceKernelError',
        code: 'INVALID_REQUEST',
        fallbackEligible: false,
      });
      expect(callerViews.map((view) => view.byteLength)).toEqual([36, 12, 8]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('uses an own captured iterator when Array.prototype is patched after module load', async () => {
    vi.resetModules();
    const nativeClone = globalThis.structuredClone;
    const nativeIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    ) as PropertyDescriptor;
    let frozenTransport = false;
    vi.stubGlobal('structuredClone', (
      buffers: ArrayBuffer[],
      options: StructuredSerializeOptions,
    ) => {
      frozenTransport = Object.isFrozen(buffers);
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value: () => { throw new Error('late iterator monkeypatch'); },
        writable: true,
      });
      try {
        return nativeClone(buffers, options);
      } finally {
        Object.defineProperty(Array.prototype, Symbol.iterator, nativeIteratorDescriptor);
      }
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      expect(() => isolated.validateSliceBatchRequest(source, continueCheckpoint)).not.toThrow();
      expect(frozenTransport).toBe(true);
      expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
        .toEqual([0, 0, 0]);
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, nativeIteratorDescriptor);
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('uses an own captured next when the shared array iterator prototype is patched', async () => {
    vi.resetModules();
    const nativeClone = globalThis.structuredClone;
    const iteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;
    const nextDescriptor = Object.getOwnPropertyDescriptor(
      iteratorPrototype,
      'next',
    ) as PropertyDescriptor & { value: (...args: unknown[]) => IteratorResult<unknown> };
    let maliciousNextCalls = 0;
    let privateOwnNext = false;
    let privateNextConfigurable = true;
    vi.stubGlobal('structuredClone', (
      buffers: ArrayBuffer[],
      options: StructuredSerializeOptions,
    ) => {
      Object.defineProperty(iteratorPrototype, 'next', {
        configurable: true,
        value: function maliciousNext(...args: unknown[]): IteratorResult<unknown> {
          maliciousNextCalls += 1;
          const result = Reflect.apply(
            nextDescriptor.value,
            this,
            args,
          ) as IteratorResult<ArrayBuffer>;
          if (!result.done) {
            return { done: false, value: new ArrayBuffer((result.value as ArrayBuffer).byteLength) };
          }
          return result;
        },
        writable: true,
      });
      try {
        const privateIterator = buffers[Symbol.iterator]();
        const privateNext = Object.getOwnPropertyDescriptor(privateIterator, 'next');
        privateOwnNext = Object.hasOwn(privateIterator, 'next')
          && privateNext?.value === nextDescriptor.value;
        privateNextConfigurable = privateNext?.configurable ?? true;
        return nativeClone(buffers, options);
      } finally {
        Object.defineProperty(iteratorPrototype, 'next', nextDescriptor);
      }
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      expect(() => isolated.validateSliceBatchRequest(source, continueCheckpoint)).not.toThrow();
      expect(maliciousNextCalls).toBe(0);
      expect(privateOwnNext).toBe(true);
      expect(privateNextConfigurable).toBe(false);
      expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
        .toEqual([0, 0, 0]);
    } finally {
      Object.defineProperty(iteratorPrototype, 'next', nextDescriptor);
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it.each([
    ['an extra own key', (privateBuffers: ArrayBuffer[]) => {
      Object.defineProperty(privateBuffers, 'extra', { value: true });
      return privateBuffers;
    }],
    ['an accessor index', (privateBuffers: ArrayBuffer[]) => {
      const first = privateBuffers[0];
      Object.defineProperty(privateBuffers, '0', {
        configurable: true,
        enumerable: true,
        get: () => first,
      });
      return privateBuffers;
    }],
    ['a throwing numeric descriptor trap', (privateBuffers: ArrayBuffer[]) => new Proxy(
      privateBuffers,
      {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === '0') throw new Error('private numeric descriptor');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    )],
  ] as const)(
    'rejects a clone-return container with %s',
    async (_label, mutateContainer) => {
      vi.resetModules();
      const nativeClone = globalThis.structuredClone;
      vi.stubGlobal('structuredClone', (
        buffers: ArrayBuffer[],
        options: StructuredSerializeOptions,
      ) => mutateContainer(nativeClone(buffers, options)));
      try {
        const isolated = await import('./slice-kernel-contract');
        const source = request();
        const error = captureFailure(() => isolated.validateSliceBatchRequest(
          source,
          continueCheckpoint,
        ));
        expect(error).toMatchObject({
          name: 'SliceKernelError',
          code: 'INVALID_REQUEST',
          fallbackEligible: false,
        });
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );

  it.each(['length', '0'] as const)(
    'snapshots clone-return descriptors without invoking a %s value trap',
    async (throwingKey) => {
      vi.resetModules();
      const nativeClone = globalThis.structuredClone;
      let valueTrapCalls = 0;
      vi.stubGlobal('structuredClone', (
        buffers: ArrayBuffer[],
        options: StructuredSerializeOptions,
      ) => new Proxy(nativeClone(buffers, options), {
        get: (target, key, receiver) => {
          if (key === throwingKey) {
            valueTrapCalls += 1;
            throw new Error('private clone value');
          }
          return Reflect.get(target, key, receiver);
        },
      }));
      try {
        const isolated = await import('./slice-kernel-contract');
        const source = request();
        expect(() => isolated.validateSliceBatchRequest(source, continueCheckpoint)).not.toThrow();
        expect(valueTrapCalls).toBe(0);
        expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
          .toEqual([0, 0, 0]);
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );

  it('accepts native transfer of a zero-byte result buffer and detaches its source', () => {
    const source = request();
    const encoded = emptyEncodedResult() as {
      endpoints: Float64Array;
    };
    const endpointBuffer = encoded.endpoints.buffer;
    const parsed = parseResult(encoded, source, continueCheckpoint);
    expect(parsed.endpoints.length).toBe(0);
    expect(() => endpointBuffer.slice(0)).toThrow();
  });

  it('rejects a fake clone that leaves only a zero-byte source attached', async () => {
    vi.resetModules();
    const nativeClone = globalThis.structuredClone;
    vi.stubGlobal('structuredClone', (buffers: ArrayBuffer[]) => {
      const privateBuffers = new Array<ArrayBuffer>(buffers.length);
      const nonZeroBuffers: ArrayBuffer[] = [];
      const nonZeroIndices: number[] = [];
      for (let index = 0; index < buffers.length; index += 1) {
        if (buffers[index].byteLength === 0) {
          privateBuffers[index] = buffers[index].slice(0);
        } else {
          nonZeroBuffers.push(buffers[index]);
          nonZeroIndices.push(index);
        }
      }
      const transferred = nativeClone(nonZeroBuffers, { transfer: nonZeroBuffers });
      for (let index = 0; index < transferred.length; index += 1) {
        privateBuffers[nonZeroIndices[index]] = transferred[index];
      }
      return privateBuffers;
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      const encoded = emptyEncodedResult() as { endpoints: Float64Array };
      const endpointBuffer = encoded.endpoints.buffer;
      const error = captureFailure(() => isolated.parseSliceBatchResult(
        encoded,
        source,
        continueCheckpoint,
      ));
      expect(error).toMatchObject({
        name: 'SliceKernelError',
        code: 'INVALID_REQUEST',
        fallbackEligible: false,
      });
      expect(endpointBuffer.byteLength).toBe(0);
      expect(() => endpointBuffer.slice(0)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('transfers all six direct-parser buffers in exactly one atomic call', async () => {
    vi.resetModules();
    const nativeClone = globalThis.structuredClone;
    const transferLengths: number[] = [];
    vi.stubGlobal('structuredClone', (
      value: unknown,
      options: StructuredSerializeOptions,
    ) => {
      transferLengths.push(options.transfer?.length ?? 0);
      return nativeClone(value, options);
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      const encoded = encodedResult() as {
        planeOffsets: Uint32Array;
        endpoints: Float64Array;
        diagnosticCounters: Uint32Array;
      };
      const callerViews = [
        source.positions,
        source.indices,
        source.planes,
        encoded.planeOffsets,
        encoded.endpoints,
        encoded.diagnosticCounters,
      ] as const;
      const parsed = isolated.parseSliceBatchResult(encoded, source, continueCheckpoint);
      expect(transferLengths).toEqual([6]);
      expect(callerViews.map((view) => view.byteLength)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(Array.from(parsed.endpoints)).toEqual([0, 0, 1, 1]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('keeps all six direct-parser buffers attached when transfer throws before detaching', async () => {
    vi.resetModules();
    const transferLengths: number[] = [];
    vi.stubGlobal('structuredClone', (
      _value: unknown,
      options: StructuredSerializeOptions,
    ) => {
      transferLengths.push(options.transfer?.length ?? 0);
      throw new DOMException('private', 'DataCloneError');
    });
    try {
      const isolated = await import('./slice-kernel-contract');
      const source = request();
      const encoded = encodedResult() as {
        planeOffsets: Uint32Array;
        endpoints: Float64Array;
        diagnosticCounters: Uint32Array;
      };
      const callerViews = [
        source.positions,
        source.indices,
        source.planes,
        encoded.planeOffsets,
        encoded.endpoints,
        encoded.diagnosticCounters,
      ] as const;
      const before = callerViews.map((view) => view.byteLength);
      const error = captureFailure(
        () => isolated.parseSliceBatchResult(encoded, source, continueCheckpoint),
      );
      expect(error).toMatchObject({ name: 'SliceKernelError', fallbackEligible: false });
      expect(transferLengths).toEqual([6]);
      expect(callerViews.map((view) => view.byteLength)).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('rejects resizable request and result buffers with typed validation and no fallback', () => {
    const resizablePositions = resizableView(Float32Array, 9);
    let requestCheckpointCount = 0;
    expectValidationAndFallbackDenied(() => validateRequest(
      request({ positions: resizablePositions }),
      () => {
        requestCheckpointCount += 1;
        (resizablePositions.buffer as ArrayBuffer & { resize(length: number): void }).resize(0);
        return undefined;
      },
    ), 'INVALID_REQUEST');
    expect(requestCheckpointCount).toBe(0);

    const resizableOffsets = resizableView(Uint32Array, 2);
    let resultCheckpointCount = 0;
    expectValidationAndFallbackDenied(() => parseResult(
      encodedResult({ planeOffsets: resizableOffsets }),
      request(),
      () => {
        resultCheckpointCount += 1;
        (resizableOffsets.buffer as ArrayBuffer & { resize(length: number): void }).resize(0);
        return undefined;
      },
    ), 'INVALID_RESULT');
    expect(resultCheckpointCount).toBe(0);
  });

  it('transfers direct-parser result ownership before checkpoints and exposes no mutable buffer', () => {
    const encoded = encodedResult() as Record<string, unknown>;
    const callerViews = [
      encoded.planeOffsets as Uint32Array,
      encoded.endpoints as Float64Array,
      encoded.diagnosticCounters as Uint32Array,
    ] as const;
    const parsed = parseResult(encoded, request(), () => {
      for (const view of callerViews) {
        expect(view.byteLength).toBe(0);
        try { view[0] = 99; } catch { /* detached writes may throw */ }
      }
      return undefined;
    });
    expect(Array.from(parsed.endpoints)).toEqual([0, 0, 1, 1]);
    expect(callerViews.map((view) => view.byteLength)).toEqual([0, 0, 0]);
    expect(Reflect.ownKeys(parsed.endpoints).sort()).toEqual([
      'byteLength',
      'elementType',
      'length',
    ]);
  });

  it('does not export an arbitrary eligible-error issuer or permit legacy mapper misuse', () => {
    const moduleRecord = contractModule as unknown as Record<string, unknown>;
    const legacyIssuer = moduleRecord.createSliceKernelRuntimeError;
    if (typeof legacyIssuer === 'function') {
      const forged = legacyIssuer('LOAD_FAILED', 'external misuse');
      expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(forged)).toThrowError(
        expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
      );
    }
    expect(Object.hasOwn(moduleRecord, 'createSliceKernelRuntimeError')).toBe(false);
    expect(Reflect.ownKeys(loaderModule).filter((key) => typeof key === 'string').sort()).toEqual([
      'disposeSliceKernel',
      'loadSliceKernel',
    ]);
  });

  it('does not grant ordinary-result fallback before complete typed-array inspection', () => {
    expectValidationAndFallbackDenied(
      () => parseSliceBatchResult(encodedResult({
        version: 2,
        planeOffsets: new Proxy(new Uint32Array([0, 1]), {}),
      }), request()),
      'INVALID_RESULT',
    );
  });

  it.each([
    [{ reason: 'cancelled', source: 'user' }, 'CANCELLED'],
    [{ reason: 'deadline', source: 'runtime-deadline' }, 'DEADLINE_EXCEEDED'],
  ] as const)(
    'preserves immediate and delayed snapshot abort $0.reason as $1',
    (abort, code) => {
      for (const trigger of [1, 3]) {
        let checkpointCount = 0;
        const error = captureFailure(() => validateRequest(request(), () => {
          checkpointCount += 1;
          return checkpointCount === trigger ? abort : undefined;
        }));
        expect(error).toMatchObject({
          name: 'SliceKernelError',
          code,
          abortSource: abort.source,
        });
        expect(checkpointCount).toBe(trigger);
        expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
          expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
        );
      }
    },
  );

  it('keeps transferred values stable across delayed caller mutation attempts', () => {
    const source = request();
    let requestCheckpointCount = 0;
    expect(() => validateRequest(source, () => {
      requestCheckpointCount += 1;
      if (requestCheckpointCount === 3) {
        try { source.positions[0] = Number.NaN; } catch { /* detached writes may throw */ }
        try { source.indices[0] = 999; } catch { /* detached writes may throw */ }
        try { source.planes[0] = Number.NaN; } catch { /* detached writes may throw */ }
      }
      return undefined;
    })).not.toThrow();
    expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
      .toEqual([0, 0, 0]);

    const encoded = encodedResult() as Record<string, unknown>;
    let resultCheckpointCount = 0;
    const parsed = parseResult(encoded, request(), () => {
      resultCheckpointCount += 1;
      if (resultCheckpointCount === 5) {
        const endpoints = encoded.endpoints as Float64Array;
        try { endpoints[0] = Number.NaN; } catch { /* detached writes may throw */ }
      }
      return undefined;
    });
    expect(Array.from(parsed.endpoints)).toEqual([0, 0, 1, 1]);
  });

  it('transfers a near-limit request without bulk-copy allocation checkpoints', () => {
    const positions = new Float32Array((4_096 * 2) + 1);
    let checkpointCount = 0;
    validateRequest(request({ positions }), () => {
      checkpointCount += 1;
      return undefined;
    });
    expect(checkpointCount).toBe(5);
    expect(positions.byteLength).toBe(0);
  });

  it('validates near-limit results without interval-segmented storage', () => {
    const endpointLength = (4_096 * 2) + 4;
    const segmentCount = endpointLength / 4;
    const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
    diagnosticCounters[3] = 1;
    diagnosticCounters[4] = segmentCount;
    let checkpointCount = 0;
    const parsed = parseResult(encodedResult({
      planeOffsets: new Uint32Array([0, segmentCount]),
      endpoints: new Float64Array(endpointLength),
      diagnosticCounters,
    }), request(), () => {
      checkpointCount += 1;
      return undefined;
    });
    expect(parsed.endpoints).toHaveLength(endpointLength);
    expect(checkpointCount).toBe(7);
    expect(Reflect.ownKeys(parsed.endpoints)).toHaveLength(3);
  });

  it('keeps interval=1 near-limit result storage object count constant', () => {
    const endpointLength = 262_144 * 4;
    const segmentCount = endpointLength / 4;
    const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
    diagnosticCounters[3] = 1;
    diagnosticCounters[4] = segmentCount;
    const activeRequest = request({ deadlineCheckInterval: 1 });
    const encoded = encodedResult({
      planeOffsets: new Uint32Array([0, segmentCount]),
      endpoints: new Float64Array(endpointLength),
      diagnosticCounters,
    });

    const parsed = parseResult(encoded, activeRequest, continueCheckpoint);
    expect(parsed.endpoints.byteLength).toBe(8 * 1024 * 1024);
    expect(Reflect.ownKeys(parsed.endpoints).sort()).toEqual([
      'byteLength',
      'elementType',
      'length',
    ]);
    expect(Object.getOwnPropertySymbols(parsed.endpoints)).toHaveLength(0);
  });

  it('rejects a request allocation above its explicit cap before any checkpoint or fallback', () => {
    const oversizedPlanes = new Float64Array(16_385);
    let checkpointCount = 0;
    const error = captureFailure(() => validateRequest(
      request({ planes: oversizedPlanes }),
      () => {
        checkpointCount += 1;
        return undefined;
      },
    ));
    expect(error).toMatchObject({ name: 'SliceKernelError', code: 'RESOURCE_LIMIT' });
    expect(checkpointCount).toBe(0);
    expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
      expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
    );
  });

  it('atomically claims fallback publication and rejects an interleaved late WASM claim', async () => {
    const guard = new CanonicalFallbackGuard();
    const fallbackToken = guard.claimTypeScriptFallback(ordinaryInvalidResultFailure());

    await Promise.resolve();
    expectKernelCode(() => guard.claimWasmPublication(), 'PUBLICATION_CONFLICT');
    await expect(guard.publishCanonicalResult(fallbackToken, async () => 'fallback'))
      .resolves.toBe('fallback');
  });

  it('keeps a non-hostile validated INVALID_RESULT eligible before publication', () => {
    const error = captureFailure(
      () => parseSliceBatchResult(encodedResult({ version: 2 }), request()),
    );
    expect(error).toMatchObject({
      name: 'SliceKernelError',
      code: 'INVALID_RESULT',
      fallbackEligible: true,
    });
    expect(new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toBeDefined();
  });

  it('rejects forged, late, and duplicate publication tokens', () => {
    const guard = new CanonicalFallbackGuard();
    const wasmToken = guard.claimWasmPublication();

    expectKernelCode(
      () => guard.publishCanonicalResult({} as never, () => undefined),
      'PUBLICATION_CONFLICT',
    );
    expect(guard.publishCanonicalResult(wasmToken, () => 'wasm')).toBe('wasm');
    expectKernelCode(
      () => guard.publishCanonicalResult(wasmToken, () => undefined),
      'PUBLICATION_CONFLICT',
    );
    expectKernelCode(
      () => guard.claimTypeScriptFallback(ordinaryInvalidResultFailure()),
      'PUBLICATION_CONFLICT',
    );
  });

  it.each(['CANCELLED', 'DEADLINE_EXCEEDED', 'DEADLINE_CHECK_FAILED'] as const)(
    'never downgrades %s to compatibility fallback',
    (code) => {
      const guard = new CanonicalFallbackGuard();
      expectKernelCode(
        () => guard.claimTypeScriptFallback(new SliceKernelError(code, 'sanitized')),
        'FALLBACK_NOT_ALLOWED',
      );
    },
  );

  it('marks publication before invoking the publisher so thrown publication cannot reopen fallback', () => {
    const guard = new CanonicalFallbackGuard();
    const token = guard.claimWasmPublication();
    expect(() => guard.publishCanonicalResult(token, () => { throw new Error('publisher failed'); }))
      .toThrow('publisher failed');
    expectKernelCode(
      () => guard.claimTypeScriptFallback(ordinaryInvalidResultFailure()),
      'PUBLICATION_CONFLICT',
    );
  });
});
