import { useEffect, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionRecovery } from "../shared/types.js";
import { unwrap } from "./controller.js";
import type { Rpc } from "./controller.js";
export interface RecoveryBinding {
  id: string;
  rpc: Rpc;
  subscribe(listener: () => void): () => void;
  running(): boolean;
  matches(value: SessionRecovery): boolean;
  send(): Promise<void>;
}
export function RecoveryNotice({ binding }: { binding: RecoveryBinding }) {
  const [value, setValue] = useState<SessionRecovery | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [, refresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let sequence = 0;
    const read = () => {
      refresh((n) => n + 1);
      if (binding.running()) return;
      const revision = ++sequence;
      void binding.rpc
        .sessionRecovery(binding.id, abort.signal)
        .then(unwrap)
        .then((v) => {
          if (!abort.signal.aborted && revision === sequence) setValue(v);
        })
        .catch(() => {});
    };
    const stop = binding.subscribe(read);
    read();
    return () => {
      abort.abort();
      stop();
    };
  }, [binding]);
  if (
    !value ||
    !["length", "disconnected", "timeout", "invalid"].includes(value.state)
  )
    return null;
  const sameModel = binding.matches(value);
  return (
    <div className="dsh-connect-router cr-recovery" role="status">
      <span>
        {value.state === "length" ? "回答达到长度限制" : "回答不完整"} ·
        已保留内容
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || binding.running() || !sameModel}
        title={sameModel ? "提交一条继续生成请求" : "请先选回中断时的模型"}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            if (!binding.matches(value) || binding.running())
              throw new Error("请保持原模型并等待当前请求结束");
            await binding.send();
            setValue(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : "继续生成失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        继续生成
      </Button>
      {!sameModel && <small>请选回 {value.model}</small>}
      {error && <span className="cr-error">{error}</span>}
    </div>
  );
}
