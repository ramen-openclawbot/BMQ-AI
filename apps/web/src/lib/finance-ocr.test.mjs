import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFinanceOcrBackendFailure,
  getFinanceOcrBackendErrorMessage,
  getFinanceOcrBackendWarningMessage,
  isFinanceOcrBackendIssue,
} from './finance-ocr.js';

test('classifyFinanceOcrBackendFailure marks AbortError as timeout', () => {
  const failure = classifyFinanceOcrBackendFailure(new Error('AbortError: signal timed out'));

  assert.equal(failure.backendStatus, 'timeout');
  assert.equal(failure.warningCode, 'OCR_BACKEND_TIMEOUT');
  assert.match(failure.warningMessage, /PaddleOCR CPU/);
});

test('classifyFinanceOcrBackendFailure marks network failure as unreachable', () => {
  const failure = classifyFinanceOcrBackendFailure(new Error('fetch failed: connection refused'));

  assert.equal(failure.backendStatus, 'unreachable');
  assert.equal(failure.warningCode, 'OCR_BACKEND_UNREACHABLE');
});

test('classifyFinanceOcrBackendFailure marks TLS EOF as unreachable', () => {
  const failure = classifyFinanceOcrBackendFailure(new Error('SSLEOFError: unexpected eof while reading, no peer certificate available'));

  assert.equal(failure.backendStatus, 'unreachable');
  assert.equal(failure.warningCode, 'OCR_BACKEND_UNREACHABLE');
});

test('classifyFinanceOcrBackendFailure keeps generic certificate problems out of unreachable bucket', () => {
  const failure = classifyFinanceOcrBackendFailure(new Error('certificate has expired'));

  assert.equal(failure.backendStatus, 'bad_response');
  assert.equal(failure.warningCode, 'OCR_BACKEND_BAD_RESPONSE');
});

test('getFinanceOcrBackendWarningMessage describes fallback warning in Vietnamese', () => {
  const message = getFinanceOcrBackendWarningMessage(
    {
      backendStatus: 'unreachable',
      fallbackUsed: true,
      warningCode: 'OCR_BACKEND_UNREACHABLE',
    },
    true,
  );

  assert.match(message ?? '', /PaddleOCR CPU/);
  assert.match(message ?? '', /dự phòng/);
});

test('getFinanceOcrBackendWarningMessage localizes by code even if warningMessage exists', () => {
  const message = getFinanceOcrBackendWarningMessage(
    {
      backendStatus: 'unreachable',
      fallbackUsed: true,
      warningCode: 'OCR_BACKEND_UNREACHABLE',
      warningMessage: 'Vietnamese server text',
    },
    false,
  );

  assert.match(message ?? '', /unreachable/i);
  assert.doesNotMatch(message ?? '', /Vietnamese server text/);
});

test('getFinanceOcrBackendErrorMessage describes hard failure in Vietnamese', () => {
  const message = getFinanceOcrBackendErrorMessage(
    {
      code: 'OCR_BACKEND_UNREACHABLE',
      error: 'Primary OCR backend offline',
    },
    true,
  );

  assert.match(message, /PaddleOCR CPU/);
  assert.match(message, /không phản hồi/);
});

test('getFinanceOcrBackendErrorMessage keeps non-backend errors unchanged', () => {
  const message = getFinanceOcrBackendErrorMessage(
    {
      code: 'RATE_LIMIT_EXCEEDED',
      error: 'Bạn đã vượt quá giới hạn scan hôm nay.',
    },
    true,
  );

  assert.equal(message, 'Bạn đã vượt quá giới hạn scan hôm nay.');
});

test('isFinanceOcrBackendIssue detects warning metadata', () => {
  assert.equal(
    isFinanceOcrBackendIssue({ warningCode: 'OCR_BACKEND_BAD_RESPONSE' }),
    true,
  );
  assert.equal(isFinanceOcrBackendIssue({ backendStatus: 'ok' }), false);
});
