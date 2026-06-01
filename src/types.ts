export interface TeeCapacity {
  tee_type: string;
  total_nodes: number;
  active_nodes: number;
  available_nodes: number;
}

export interface CapacityResponse {
  total_nodes: number;
  active_nodes: number;
  available_nodes: number;
  by_tee_type: TeeCapacity[];
  updated_at?: string;
}

export interface ModelPricing {
  price_per_1k_input_tokens_usd: number;
  price_per_1k_output_tokens_usd: number;
}

export interface ModelInfo {
  id: string;
  owned_by: string;
  sgl_node_count: number;
  sgl_tee_types: string[];
  sgl_pricing?: ModelPricing;
}

export interface PricingInfo {
  model: string;
  price_per_1k_input_tokens_usd: number;
  price_per_1k_output_tokens_usd: number;
}

export interface JobSubmission {
  model: string;
  input: Record<string, unknown>;
  submitter_wallet?: string;
  submitter_chain?: string;
}

export interface JobResponse {
  job_id: string;
  status: string;
  model: string;
  node_id?: string;
  tee_type?: string;
  estimated_cost_usd?: number;
  created_at?: string;
}

export interface AttestationProof {
  node_id: string;
  tee_type: string;
  job_id: string;
  attestation_signature: string;
  attestation_report?: string;
  verified: boolean;
  verified_at?: string;
}

export interface JobResult {
  id: string;
  status: string;
  model: string;
  node_id?: string;
  tee_type?: string;
  result?: Record<string, unknown>;
  encrypted_result?: string;
  attestation_proof?: AttestationProof;
  cost_usd?: number;
  created_at?: string;
  completed_at?: string;
  error?: string;
}

export interface GridClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Processors ──────────────────────────────────────────────────────────────

export interface DeployProcessorOptions {
  name: string;
  code: string;
  runtime?: "deno" | "wasm";
  memory_mb?: number;
  timeout_seconds?: number;
  tee_type_required?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessorInfo {
  id: string;
  name: string;
  owner_wallet: string;
  owner_chain: string;
  runtime: string;
  memory_mb: number;
  timeout_seconds: number;
  tee_type_required?: string;
  invocation_count: number;
  last_invoked_at?: string;
  status: string;
  code_hash?: string;
  deployment_stake_sgl: number;
  invoke_url: string;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessorDeployResult {
  id: string;
  name: string;
  runtime: string;
  memory_mb: number;
  timeout_seconds: number;
  status: string;
  code_hash: string;
  invoke_url: string;
  tier: string;
  sgl_staked: number;
  created_at: string;
}

export interface ProcessorInvokeResult {
  job_id: string;
  processor: string;
  status: string;
  output?: unknown;
  duration_ms?: number;
  payment?: {
    amount_usd: string;
    token: string;
    discount_pct: number;
  };
  tee?: {
    node_id: string;
    tee_type: string;
    attestation_verified: boolean;
  };
  message?: string;
}

export interface ProcessorListResponse {
  processors: ProcessorInfo[];
  total: number;
  page: number;
  limit: number;
}

export interface ProcessorLogEntry {
  id: string;
  processor_id: string;
  job_id: string;
  node_id: string;
  duration_ms?: number;
  status: string;
  error_message?: string;
  created_at: string;
}

export interface ProcessorLogsResponse {
  logs: ProcessorLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface WalletAuth {
  address: string;
  chain?: string;
  signature: string;
  timestamp: string;
  nonce: string;
}
