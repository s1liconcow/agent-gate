// Diagnostic identifiers contain no page text, URLs, values or credentials.
export const executionErrors = Object.freeze(['TASK_VIEW_CHANGED', 'PURPOSE_CHECK_MISSING', 'APPROVAL_CHANGED', 'ORIGIN_CHANGED', 'AUTHORITY_ENDED', 'READER_UNAVAILABLE', 'EVALUATION_FAILED', 'TRANSPORT_FAILED', 'INVALID_RESPONSE', 'COMMAND_CHANGED', 'UNEXPECTED_ERROR']);
const messages = new Map([
  ['The task view changed.', 'TASK_VIEW_CHANGED'],
  ['No matching purpose check.', 'PURPOSE_CHECK_MISSING'],
  ['Action approval policy changed.', 'APPROVAL_CHANGED'],
  ['No exact action approval.', 'APPROVAL_CHANGED'],
  ['Action differs from its phone approval.', 'APPROVAL_CHANGED'],
  ['The bound tab changed origin.', 'ORIGIN_CHANGED'],
  ['Invalid browser adapter response.', 'INVALID_RESPONSE'],
  ['Command authorization changed.', 'COMMAND_CHANGED']
]);
export function executionError(error) {
  if (executionErrors.includes(error?.execution_error)) return error.execution_error;
  if (messages.has(error?.message)) return messages.get(error.message);
  if (error?.code === 'INFERENCE_NOT_APPROVED') return 'AUTHORITY_ENDED';
  if (error?.code === 'BROWSER_UNRESPONSIVE' || error?.name === 'ProtocolError') return 'TRANSPORT_FAILED';
  return 'UNEXPECTED_ERROR';
}
