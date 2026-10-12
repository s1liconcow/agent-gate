export const remoteCodes=['INFERENCE_NOT_APPROVED','INFERENCE_CONFIG_CHANGED','INFERENCE_UNAVAILABLE'];
export const inferenceError=(code='INFERENCE_UNAVAILABLE')=>Object.assign(new Error('The selected local classifier is unavailable or its authorization changed.'),{code});
