import { useEffect } from "react";
import { ArrowUpRight, RefreshCw, ShieldCheck, UserPlus, Users } from "lucide-react";
import { runtime } from "../runtime";
import { Button, Card, PageHeader, useRuntime } from "../ui";
import { notify } from "../notification";

export function AccountsView() {
  const { accounts, status } = useRuntime();

  useEffect(() => {
    if (status.state === "RUNNING") {
      runtime.loadAccounts().catch(() => undefined);
    }
  }, [status.state]);

  const oauth = () => runtime.openExternal(`http://${status.host}:${status.port}/oauth/start`);

  async function refresh() {
    notify("info", "正在刷新账号配额…");
    try {
      await runtime.refreshAccounts();
      notify("success", "账号状态已更新");
    } catch (error) {
      notify("error", `刷新失败：${String(error)}`);
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="ACCOUNT POOL"
        title="账号与额度"
        description="管理 Google Antigravity 授权账号及其健康状态。"
        actions={
          <>
            <Button variant="ghost" onClick={refresh} disabled={status.state !== "RUNNING"}>
              <RefreshCw size={15} />刷新配额
            </Button>
            <Button onClick={oauth}>
              <UserPlus size={15} />绑定账号
            </Button>
          </>
        }
      />
      <div className="account-summary">
        <Card>
          <Users size={18} />
          <span>
            账号总数<strong>{accounts.length}</strong>
          </span>
        </Card>
        <Card>
          <ShieldCheck size={18} />
          <span>
            健康账号
            <strong>
              {accounts.filter((account) => (account.healthScore ?? account.health ?? 100) > 50).length}
            </strong>
          </span>
        </Card>
      </div>
      <div className="accounts-list">
        {accounts.map((account, index) => {
          const health = account.healthScore ?? account.health ?? 100;
          const models = Array.isArray(account.supportedModels)
            ? account.supportedModels
            : Array.isArray(account.models)
              ? account.models
              : [];
          return (
            <Card className="account-row" key={`${account.email || "account"}-${index}`}>
              <div className="account-avatar">{(account.email || "G")[0].toUpperCase()}</div>
              <div className="account-main">
                <h3>{account.email || "Google 开发者账号"}</h3>
                <p>Project ID · {account.projectId || "自动检测"}</p>
              </div>
              <div className="account-stat">
                <span>健康度</span>
                <b className={health > 50 ? "good" : "bad"}>{health}%</b>
              </div>
              <div className="account-stat">
                <span>可用模型</span>
                <b>{models.length}</b>
              </div>
              <Button
                variant="ghost"
                onClick={() => runtime.openExternal(`http://${status.host}:${status.port}/frontend/index.html`)}
              >
                详情 <ArrowUpRight size={14} />
              </Button>
            </Card>
          );
        })}
        {!accounts.length && (
          <Card className="account-empty">
            <div className="empty-orbit">
              <Users size={28} />
            </div>
            <h2>还没有授权账号</h2>
            <p>启动 Core 后，通过 Google OAuth 添加第一个 Antigravity 账号。</p>
            <Button onClick={oauth}>
              <UserPlus size={15} />开始授权
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
