// Static progress metadata only. Never include candidates, prompts or model text.
export const modelPhases = ['model_availability', 'model_startup', 'text_selection', 'text_verification', 'control_selection', 'control_verification', 'action_check', 'access_check'];
export const browserPhases = ['opening_tab', 'page_loading', 'capture', ...modelPhases, 'view_validation', 'publishing', 'ready'];
