import { Agent } from '@mastra/core/agent';
import type { AgentKind } from '@repo/db';

export type AgentPromptConfig = {
  kind: AgentKind;
  instructions: string;
  modelString: string;
};

/**
 * Create a Mastra Agent instance with the given instructions and model.
 * The model string uses OpenRouter format: "openrouter/vendor/model-name".
 */
export function createEstimationAgent(config: AgentPromptConfig): Agent {
  return new Agent({
    id: config.kind,
    name: config.kind,
    instructions: config.instructions,
    model: {
      id: config.modelString as `${string}/${string}`,
      apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
      url: 'https://openrouter.ai/api/v1',
      headers: {
        'HTTP-Referer': 'https://codup.co',
        'X-Title': 'Codup AI Estimation',
      },
    },
  });
}

/**
 * Boot all agents from their active prompt configs.
 * Returns a map of AgentKind → Agent instance.
 */
export function bootAgents(
  configs: AgentPromptConfig[],
): Map<AgentKind, Agent> {
  const agents = new Map<AgentKind, Agent>();
  for (const cfg of configs) {
    agents.set(cfg.kind, createEstimationAgent(cfg));
  }
  return agents;
}

export const AGENT_KINDS: AgentKind[] = [
  'SUPERVISOR',
  'LIBRARIAN',
  'DETECTIVE',
  'ARCHIVIST',
  'SPECIALIST_DEV',
  'SPECIALIST_QA',
  'SPECIALIST_PM',
  'SPECIALIST_BA',
  'ARCHITECT',
];
