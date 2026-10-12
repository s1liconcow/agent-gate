import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {apiVersion, tools, toolBody} from './contract.mjs';
export function createServer(client, remote = false, approvalOrigin = client.url) {
  const server = new McpServer({name: 'AgentGate', version: apiVersion});
  for (const [name, definition] of Object.entries(tools)) server.registerTool(name, {
    description: definition.description, inputSchema: definition.schema,
    annotations: {readOnlyHint: definition.readOnly, destructiveHint: false, idempotentHint: name!=='request_browser_session', openWorldHint: !definition.readOnly},
    ...(remote ? {_meta: {securitySchemes: [{type: 'oauth2', scopes: ['browser:delegate']}]}} : {})
  }, async raw => {
    try {
      const {path, body} = toolBody(name, raw);
      let result = await client.call(path, body);
      if (approvalOrigin && ['requested','awaiting_action'].includes(result.status)) result = {...result, approval_url: approvalOrigin + '/#session=' + result.id};
      result = {...result, api_version: apiVersion};
      return {content: [{type: 'text', text: JSON.stringify(result)}, ...(result.approval_url ? [{type: 'resource_link', uri: result.approval_url, name: 'Review task approval'}] : [])], structuredContent: result};
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: JSON.stringify({error: {code: error.code || 'INVALID_REQUEST', message: error.code ? error.message : 'Check the advertised tool schema and coordinator connection.'}, api_version: apiVersion})}]};
    }
  });
  return server;
}
