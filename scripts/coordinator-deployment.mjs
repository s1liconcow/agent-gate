// Metadata for deployments through the connected Cloudflare API.
export function coordinatorDeploymentMetadata(settings, message) {
  return {
    main_module: 'worker.mjs',
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    bindings: settings.bindings.filter(binding => binding.type !== 'secret_text').map(binding => {
      if (binding.type === 'durable_object_namespace' && !binding.script_name && !binding.dispatch_namespace) {
        if (!binding.class_name) throw new Error('The account backend binding is missing its class name.');
        return {name: binding.name, type: binding.type, class_name: binding.class_name};
      }
      return {name: binding.name, type: 'inherit'};
    }),
    keep_bindings: ['secret_text'],
    code_update_strategy: {mode: 'immediate'},
    usage_model: settings.usage_model,
    logpush: settings.logpush,
    ...(settings.observability ? {observability: settings.observability} : {}),
    annotations: {'workers/message': message}
  };
}
