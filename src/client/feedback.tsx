import { useEffect, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { unwrap } from "./controller.js";
import type { RouterClient } from "./controller.js";
import type { LogFilter } from "../shared/types.js";
import { FEEDBACK_REPOSITORY } from "../shared/feedback.js";
import type {
  FeedbackAuth,
  FeedbackLogin,
  FeedbackReport,
} from "../shared/feedback.js";

const messages: Record<string, string> = {
  GITHUB_APP_NOT_CONFIGURED: "反馈应用尚未配置，可先导出诊断包。",
  GITHUB_AUTH_REQUIRED: "GitHub 授权已失效，请重新连接。",
  GITHUB_FORBIDDEN: "GitHub 拒绝提交，请检查仓库权限或稍后重试。",
  GITHUB_RATE_LIMITED: "GitHub 请求过于频繁，请稍后再试。",
  GITHUB_NETWORK_ERROR: "无法连接 GitHub，请检查网络后重试。",
  GITHUB_TIMEOUT: "GitHub 连接超时，请稍后重试。",
  GITHUB_AUTH_DENIED: "已取消 GitHub 授权。",
  GITHUB_AUTH_EXPIRED: "授权码已到期，请重新连接。",
  GITHUB_RESULT_UNKNOWN: "提交结果待核对，请先查询结果，避免重复发送。",
  FEEDBACK_REPORT_EXPIRED: "反馈预览已过期，请重新生成。",
};
export function FeedbackPanel({
  client,
  filter,
  onClose,
}: {
  client: RouterClient;
  filter: LogFilter;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState("");
  const [auth, setAuth] = useState<FeedbackAuth>(),
    [login, setLogin] = useState<FeedbackLogin>();
  const [report, setReport] = useState<FeedbackReport>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [abort] = useState(() => new AbortController());
  useEffect(() => {
    void client.rpc
      .feedbackAuth(abort.signal)
      .then(unwrap)
      .then(setAuth)
      .catch((e) => setError(e.message));
    void client.rpc
      .pendingFeedback(abort.signal)
      .then(unwrap)
      .then((r) => {
        if (r) setReport(r);
      })
      .catch((e) => setError(e.message));
    return () => abort.abort();
  }, [client, abort]);
  useEffect(() => {
    if (!login) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (
          unwrap(await client.rpc.feedbackPollLogin(login.id, abort.signal))
        ) {
          if (active) {
            setLogin(undefined);
            setError("");
            setAuth(unwrap(await client.rpc.feedbackAuth(abort.signal)));
          }
          return;
        }
        if (active) timer = setTimeout(poll, login.interval);
      } catch (e) {
        if (active) {
          const code = (e as Error).message;
          setError(code);
          if ((code === "GITHUB_NETWORK_ERROR" || code === "GITHUB_TIMEOUT") && Date.now() < login.expiresAt) {
            timer = setTimeout(poll, login.interval);
          } else setLogin(undefined);
        }
      }
    };
    timer = setTimeout(poll, login.interval);
    return () => {
      active = false;
      clearTimeout(timer);
      void client.rpc.feedbackCancelLogin(login.id, client.signal);
    };
  }, [login, client, abort]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submitted = report && report.state !== "preview";
  return (
    <Modal
      open
      onClose={onClose}
      title="反馈问题"
      closeLabel="关闭反馈"
      className="cr-dialog"
    >
      <div className="dsh-connect-router cr-feedback">
        <p>
          发送至公开仓库{" "}
          <a
            href={`https://github.com/${FEEDBACK_REPOSITORY}/issues`}
            target="_blank"
            rel="noreferrer"
          >
            {FEEDBACK_REPOSITORY}
          </a>
        </p>
        <div className="cr-inline-notice">
          {auth?.connected
            ? `GitHub：${auth.login}`
            : "首次发送需要连接 GitHub"}
          {!auth?.connected && !login && (
            <Button
              variant="ghost"
              disabled={busy || !auth?.configured}
              onClick={() =>
                void run(async () =>
                  setLogin(
                    unwrap(await client.rpc.feedbackStartLogin(abort.signal)),
                  ),
                )
              }
            >
              连接 GitHub
            </Button>
          )}
          {auth?.connected && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  unwrap(await client.rpc.feedbackDisconnect(abort.signal));
                  setAuth(unwrap(await client.rpc.feedbackAuth(abort.signal)));
                })
              }
            >
              断开
            </Button>
          )}
        </div>
        {auth && !auth.configured && (
          <p className="cr-muted">反馈应用尚未配置，可先导出诊断包。</p>
        )}
        {login && (
          <div className="cr-inline-notice" role="status">
            在 GitHub 输入代码 <strong>{login.userCode}</strong>
            <a href={login.url} target="_blank" rel="noreferrer">
              打开官方授权页
            </a>
            <Button variant="ghost" onClick={() => setLogin(undefined)}>
              取消授权
            </Button>
          </div>
        )}
        {!submitted && (
          <>
            <label>
              标题
              <input
                data-modal-autofocus
                value={title}
                maxLength={160}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setReport(undefined);
                }}
              />
            </label>
            <label>
              问题描述
              <textarea
                value={description}
                maxLength={12000}
                placeholder="发生了什么？如何复现？预期结果是什么？"
                onChange={(e) => {
                  setDescription(e.target.value);
                  setReport(undefined);
                }}
              />
            </label>
            <Button
              variant="ghost"
              disabled={busy || !title.trim()}
              onClick={() =>
                void run(async () =>
                  setReport(
                    unwrap(
                      await client.rpc.previewFeedback(
                        filter,
                        title,
                        description,
                        abort.signal,
                      ),
                    ),
                  ),
                )
              }
            >
              生成脱敏预览
            </Button>
          </>
        )}
        {report && (
          <>
            <h3>发送内容预览</h3>
            <p className="cr-muted">
              请检查内容。确认发送后，以下报告将公开显示在 Issue 中。
            </p>
            <strong>{report.title}</strong>
            <pre className="cr-feedback-preview">{report.body}</pre>
            {report.state === "preview" && (
              <Button
                disabled={busy || !auth?.connected}
                onClick={() =>
                  void run(async () =>
                    setReport(
                      unwrap(
                        await client.rpc.submitFeedback(
                          report.id,
                          abort.signal,
                        ),
                      ),
                    ),
                  )
                }
              >
                确认发送
              </Button>
            )}
            {report.state === "sent" && (
              <p role="status">
                发送成功 ·{" "}
                <a href={report.url} target="_blank" rel="noreferrer">
                  查看 Issue
                </a>
              </p>
            )}
            {report.state === "pending" && (
              <p role="status">
                提交结果待核对{" "}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setReport(
                        unwrap(
                          await client.rpc.feedbackResult(
                            report.id,
                            abort.signal,
                          ),
                        ),
                      ),
                    )
                  }
                >
                  查询结果
                </Button>
              </p>
            )}
            {report.state === "failed" && (
              <p role="alert">
                {messages[report.code || ""] || report.code}
                <Button variant="ghost" onClick={() => setReport(undefined)}>
                  返回编辑
                </Button>
              </p>
            )}
          </>
        )}
        {busy && <p role="status">正在处理…</p>}
        {error && (
          <p className="cr-error" role="alert">
            {messages[error] || error}
          </p>
        )}
      </div>
    </Modal>
  );
}
