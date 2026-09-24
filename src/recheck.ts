export interface RecheckRefusal {
  schema: "pawpie-recheck@1";
  ok: false;
  reason: "not-built-yet" | "missing-id";
  id: string | null;
  message: string;
  exitCode: 2;
}

export function refuseRecheck(id: string | null): RecheckRefusal {
  if (id === null) {
    return {
      schema: "pawpie-recheck@1",
      ok: false,
      reason: "missing-id",
      id: null,
      message: "recheck/punch requires an ADR id",
      exitCode: 2,
    };
  }
  return {
    schema: "pawpie-recheck@1",
    ok: false,
    reason: "not-built-yet",
    id,
    message: "recheck/punch is not built yet",
    exitCode: 2,
  };
}
