import {defaultActionPolicy, fail} from '../shared/protocol.mjs';

export function sessionDefaults(input, inference) {
  if (input?.disclosure !== undefined) {
    const interaction = input.interaction || (input.disclosure === 'bounded' ? 'every_action' : 'automatic');
    return {...input, interaction, ...(interaction === 'automatic' && input.disclosure === 'local_planner' ? {action_policy: defaultActionPolicy} : {})};
  }
  if (['purpose_encoder', 'purpose_browser', 'openjev'].includes(inference?.provider)) {
    if (!input.permissions?.includes('read') || input.permissions.some(permission => !['read', 'navigate'].includes(permission)))
      fail('INVALID_SCOPE', 'The configured classifier supports read and navigate only. Choose another provider for fill or click tasks.');
    return {...input, disclosure: 'granular', interaction: input.interaction || 'automatic'};
  }
  const interaction = input.interaction || 'automatic';
  return {...input, disclosure: 'local_planner', interaction, ...(interaction === 'automatic' ? {action_policy: defaultActionPolicy} : {})};
}
