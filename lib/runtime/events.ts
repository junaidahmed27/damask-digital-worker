/**
 * The ledger's event names and payloads. The same record types the Inngest
 * client is typed with and the local dispatcher routes on.
 */
export type LedgerEvents = {
  "run/created": { data: { runId: string } };
  "run/rehearse": { data: { runId: string; workflowVersion?: number } };
  "contract/assigned": { data: { contractId: string; attempt?: number } };
  "contract/completed_pending_check": { data: { contractId: string } };
  "contract/awaiting_approval": { data: { contractId: string } };
  "contract/verified": { data: { contractId: string } };
  "contract/transitioned": { data: { contractId: string; from: string; to: string; hash: string } };
  "approval/decided": {
    data: { contractId: string; decision: "approve" | "hand_back"; actorId: string; reason?: string };
  };
  "worker/revoked": { data: { workerId: string } };
  "deadline/sweep": { data: Record<string, never> };
  "record/created": { data: { recordId: string; sheetId: string } };
  "rule/fired": { data: { ruleId: string; rowId: string } };
  "cell/changed": { data: { sheetId: string; rowId: string; columnId: string } };
};

export type LedgerEventName = keyof LedgerEvents;

export type LedgerEvent<N extends LedgerEventName = LedgerEventName> = {
  name: N;
  data: LedgerEvents[N]["data"];
};

export function event<N extends LedgerEventName>(name: N, data: LedgerEvents[N]["data"]): LedgerEvent<N> {
  return { name, data };
}
