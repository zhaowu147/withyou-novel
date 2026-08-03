"use client";

import { readableApiError, workspaceFetch } from "@/lib/workspaces/client";

import type { SemanticContractEditableFields, SemanticContractEnvelope, SemanticTaskKind } from "./types";

async function semanticResponse(response: Response): Promise<SemanticContractEnvelope> {
  if (!response.ok) throw new Error(await readableApiError(response, "语义契约请求失败"));
  const json = await response.json();
  if (!json.success || !json.data?.contract) throw new Error(json.error?.message || "语义契约响应无效");
  return json.data as SemanticContractEnvelope;
}

export async function createSemanticContract(input: {
  novelId: string;
  taskKind: SemanticTaskKind;
  toolId?: string;
  userInput: string;
  formData?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<SemanticContractEnvelope> {
  return semanticResponse(
    await workspaceFetch("/api/semantic-contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: input.signal,
    }),
  );
}

export async function updateSemanticContract(input: {
  novelId: string;
  contractId: string;
  version: number;
  fields: SemanticContractEditableFields;
}): Promise<SemanticContractEnvelope> {
  return semanticResponse(
    await workspaceFetch(`/api/semantic-contracts/${encodeURIComponent(input.contractId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novelId: input.novelId,
        version: input.version,
        action: "update",
        fields: input.fields,
      }),
    }),
  );
}

export async function actOnSemanticContract(input: {
  novelId: string;
  contractId: string;
  version: number;
  action: "confirm" | "reject" | "reparse";
  saveAsLongTerm?: boolean;
}): Promise<SemanticContractEnvelope> {
  return semanticResponse(
    await workspaceFetch(`/api/semantic-contracts/${encodeURIComponent(input.contractId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
