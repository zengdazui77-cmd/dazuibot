import { useEffect, useMemo, useState } from "preact/hooks";
import { html, Button, CopyButton, Notice, Sheet, Spinner } from "../components/ui.js";
import { api, watchTeamConversation } from "../lib/api.js";
import { has, t } from "../lib/i18n.js";

/** 服务端新增了审计动作或错误码而词典还没跟上时，显示代码本身，不把词典键名露给用户 */
const auditLabel = (action) => (has(`team.auditAction.${action}`) ? t(`team.auditAction.${action}`) : action);
const jobErrorLabel = (code) => (has(`team.jobError.${code}`) ? t(`team.jobError.${code}`) : t("team.jobError.unknown", { code }));

function invitationToken(value) {
  const raw = value.trim();
  try { return new URL(raw).searchParams.get("token") || raw; }
  catch { return raw; }
}

export function TeamScreen({ onBack }) {
  const [status, setStatus] = useState(null);
  const [teamId, setTeamId] = useState("");
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [bots, setBots] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [projects, setProjects] = useState([]);
  const [codeTasks, setCodeTasks] = useState({});
  const [codeTaskInputs, setCodeTaskInputs] = useState({});
  const [gitCredentials, setGitCredentials] = useState({ github: { configured: false }, gitlab: { configured: false } });
  const [githubToken, setGithubToken] = useState("");
  const [gitlabToken, setGitlabToken] = useState("");
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [createdReview, setCreatedReview] = useState(null);
  const [inspectedProjectId, setInspectedProjectId] = useState("");
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(null);
  const [remoteComparison, setRemoteComparison] = useState(null);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [modelConfig, setModelConfig] = useState(null);
  const [modelPolicy, setModelPolicy] = useState(null);
  const [policyMode, setPolicyMode] = useState("all");
  const [policyModels, setPolicyModels] = useState([]);
  const [memberModel, setMemberModel] = useState("");
  const [policyRules, setPolicyRules] = useState([]);
  const [policyViolations, setPolicyViolations] = useState([]);
  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleBlocked, setNewRuleBlocked] = useState("");
  const [newRuleRate, setNewRuleRate] = useState("");
  const [usage, setUsage] = useState(null);
  const [modelName, setModelName] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [botName, setBotName] = useState("");
  const [botDescription, setBotDescription] = useState("");
  const [botInstructions, setBotInstructions] = useState("");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [conversationTitle, setConversationTitle] = useState("");
  const [conversationVisibility, setConversationVisibility] = useState("team");
  const [messageDraft, setMessageDraft] = useState("");
  const [projectName, setProjectName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [teamName, setTeamName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("developer");
  const [inviteUrl, setInviteUrl] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 自绘确认框：Electron 不支持 window.prompt（直接返回 null），系统弹窗在桌面端等于点了没反应
  const [ask, setAsk] = useState(null);
  const [askValue, setAskValue] = useState("");
  const askUser = (opts) => new Promise((resolve) => { setAskValue(""); setAsk({ ...opts, resolve }); });
  const closeAsk = (value) => { const current = ask; setAsk(null); current?.resolve(value); };

  const refreshStatus = async () => {
    const cfg = await api("/team/config");
    setApiBaseUrl(cfg.apiBaseUrl || "");
    let me;
    try { me = await api("/team/status"); }
    catch (e) { me = { configured: !!cfg.apiBaseUrl, signedIn: false, error: e.message }; setError(e.message); }
    setStatus(me);
    const firstTeam = me.teams?.[0]?.id || "";
    setTeamId((current) => me.teams?.some((team) => team.id === current) ? current : firstTeam);
    return me;
  };
  useEffect(() => { refreshStatus().catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    const acceptLink = (event) => {
      const token = typeof event.detail === "string" ? event.detail : "";
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return;
      setInviteToken(token);
      if (window.__DAZUI_TEAM_INVITE__ === token) delete window.__DAZUI_TEAM_INVITE__;
    };
    window.addEventListener("dazuibot:team-invitation", acceptLink);
    if (window.__DAZUI_TEAM_INVITE__) acceptLink({ detail: window.__DAZUI_TEAM_INVITE__ });
    return () => window.removeEventListener("dazuibot:team-invitation", acceptLink);
  }, []);

  const selectedTeam = useMemo(() => status?.teams?.find((team) => team.id === teamId), [status, teamId]);
  const canManage = selectedTeam && (selectedTeam.role === "owner" || selectedTeam.role === "admin");
  const owner = selectedTeam?.role === "owner";
  const canDevelop = selectedTeam && selectedTeam.role !== "viewer";
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const projectKey = projects.map((project) => project.id).join(",");

  const refreshTeam = async (id = teamId, role = selectedTeam?.role) => {
    if (!id || !status?.signedIn) { setMembers([]); setInvitations([]); setAuditEvents([]); setBots([]); setConversations([]); setProjects([]); setCodeTasks({}); setCodeTaskInputs({}); setGitCredentials({ github: { configured: false }, gitlab: { configured: false } }); setMessages([]); setJobs([]); setModelConfig(null); setUsage(null); return; }
    const tasks = [api(`/team/teams/${encodeURIComponent(id)}/members`).then((x) => setMembers(x.members || []))];
    if (role === "owner" || role === "admin") tasks.push(api(`/team/teams/${encodeURIComponent(id)}/invitations`).then((x) => setInvitations(x.invitations || [])));
    else setInvitations([]);
    if (role === "owner" || role === "admin") tasks.push(api(`/team/teams/${encodeURIComponent(id)}/audit`).then((x) => setAuditEvents(x.events || [])));
    else setAuditEvents([]);
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/bots`).then((x) => {
      const next = x.bots || [];
      setBots(next);
      setSelectedBotId((current) => next.some((bot) => bot.id === current) ? current : next[0]?.id || "");
    }));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/conversations`).then((x) => {
      const next = x.conversations || [];
      setConversations(next);
      setActiveConversationId((current) => next.some((conversation) => conversation.id === current) ? current : next[0]?.id || "");
    }));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/projects`).then(async (x) => {
      const next = x.projects || [];
      setProjects(next);
      const taskEntries = await Promise.all(next.map(async (project) => {
        const result = await api(`/team/teams/${encodeURIComponent(id)}/projects/${encodeURIComponent(project.id)}/code-tasks`);
        return [project.id, result.tasks || []];
      }));
      setCodeTasks(Object.fromEntries(taskEntries));
    }));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/git-credentials`).then((x) => setGitCredentials(x.credentials || { github: { configured: false }, gitlab: { configured: false } })));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/model-config`).then((x) => {
      setModelConfig(x.modelConfig);
      if (x.modelConfig?.model) setModelName(x.modelConfig.model);
    }));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/model-policy`).then((x) => {
      setModelPolicy(x.modelPolicy);
      setPolicyMode(x.modelPolicy?.mode || "all");
      setPolicyModels(x.modelPolicy?.allowedModels || []);
      setMemberModel(x.modelPolicy?.memberModel || "");
    }));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/usage`).then((x) => setUsage(x.usage)));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/model-policy-rules`).then((x) => setPolicyRules(x.rules || [])));
    tasks.push(api(`/team/teams/${encodeURIComponent(id)}/model-policy-violations`).then((x) => setPolicyViolations(x.violations || [])));
    await Promise.all(tasks);
  };
  useEffect(() => { if (teamId && status?.signedIn) refreshTeam(teamId).catch((e) => setError(e.message)); }, [teamId, status?.signedIn, selectedTeam?.role]);
  useEffect(() => {
    if (!teamId || !status?.signedIn || !projectKey) return;
    let active = true;
    const refreshCodeTaskLists = () => Promise.all(projects.map(async (project) => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(project.id)}/code-tasks`);
      return [project.id, result.tasks || []];
    })).then((entries) => { if (active) setCodeTasks(Object.fromEntries(entries)); }).catch((e) => { if (active) setError(e.message); });
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refreshCodeTaskLists(); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [teamId, status?.signedIn, projectKey]);
  useEffect(() => {
    if (!teamId || !status?.signedIn) { setUsage(null); return; }
    let active = true;
    const refreshUsage = () => api(`/team/teams/${encodeURIComponent(teamId)}/usage`).then((result) => { if (active) setUsage(result.usage); }).catch((e) => { if (active) setError(e.message); });
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refreshUsage(); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [teamId, status?.signedIn]);
  useEffect(() => {
    if (!teamId || !activeConversationId || !status?.signedIn) { setMessages([]); setJobs([]); return; }
    let current = true;
    const refreshMessages = () => api(`/team/teams/${encodeURIComponent(teamId)}/conversations/${encodeURIComponent(activeConversationId)}/messages`)
      .then((result) => { if (current) { setMessages(result.messages || []); setJobs(result.jobs || []); } })
      .catch((e) => { if (current) setError(e.message); });
    void refreshMessages();
    const controller = new AbortController();
    let retryTimer;
    const connect = async () => {
      while (current && !controller.signal.aborted) {
        try { await watchTeamConversation(teamId, activeConversationId, { update: () => { void refreshMessages(); } }, controller.signal); }
        catch (e) {
          if (!current || e.name === "AbortError") continue;
          if (e.status === 401 || e.status === 404) void refreshStatus().catch((statusError) => setError(statusError.message));
          else setError(e.message);
        }
        if (current && !controller.signal.aborted) await new Promise((resolve) => { retryTimer = setTimeout(resolve, 1500); });
      }
    };
    void connect();
    const fallback = setInterval(() => { if (document.visibilityState !== "hidden") void refreshMessages(); }, 30_000);
    return () => { current = false; controller.abort(); clearInterval(fallback); clearTimeout(retryTimer); };
  }, [teamId, activeConversationId, status?.signedIn]);

  const run = async (fn, success) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await fn(); if (success) setNotice(success); return result; }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const requestCode = () => run(async () => {
    const result = await api("/team/auth/codes", { method: "POST", body: { email } });
    if (result.developmentCode) setCode(result.developmentCode);
    setNotice(result.developmentCode ? t("team.devCode", { code: result.developmentCode }) : t("team.codeSent"));
  });
  const signIn = () => run(async () => {
    const me = await api("/team/auth/sessions", { method: "POST", body: { email, code } });
    setStatus(me); setCode(""); setNotice(t("team.signedIn"));
  });
  const signOut = () => run(async () => {
    await api("/team/auth/sessions/current", { method: "DELETE" });
    setMembers([]); setInvitations([]); setInviteUrl("");
    await refreshStatus();
  }, t("team.signedOut"));
  const configure = (e) => {
    e.preventDefault();
    return run(async () => {
      await api("/team/config", { method: "PUT", body: { apiBaseUrl } });
      await refreshStatus();
    }, t("team.serverSaved"));
  };
  const createTeam = (e) => {
    e.preventDefault();
    return run(async () => {
      await api("/team/teams", { method: "POST", body: { name: teamName } });
      setTeamName("");
      const me = await refreshStatus();
      const created = me.teams?.at(-1);
      if (created) setTeamId(created.id);
    }, t("team.created"));
  };
  const deleteTeam = async () => {
    if (!selectedTeam || !owner) return;
    const confirmation = await askUser({ title: t("team.deleteTeam"), body: t("team.deleteTeamPrompt", { name: selectedTeam.name }), input: true, match: selectedTeam.name, danger: true });
    if (confirmation !== selectedTeam.name) return;
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}`, { method: "DELETE", body: { confirmName: confirmation } });
      setTeamId("");
      await refreshStatus();
    }, t("team.teamDeleted"));
  };
  const leaveTeam = async () => {
    if (!selectedTeam) return;
    if ((await askUser({ title: t("team.leaveTeam"), body: t("team.leaveTeamPrompt", { name: selectedTeam.name }), danger: true })) === null) return;
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}/members/me`, { method: "DELETE" });
      setTeamId("");
      await refreshStatus();
    }, t("team.teamLeft"));
  };
  const acceptInvite = (e) => {
    e.preventDefault();
    return run(async () => {
      await api("/team/invitations/accept", { method: "POST", body: { token: invitationToken(inviteToken) } });
      setInviteToken("");
      const me = await refreshStatus();
      const joined = me.teams?.at(-1);
      if (joined) setTeamId(joined.id);
    }, t("team.joined"));
  };
  const createInvite = (e) => {
    e.preventDefault();
    return run(async () => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/invitations`, { method: "POST", body: { email: inviteEmail, role: inviteRole } });
      setInviteEmail(""); setInviteUrl(result.invitation.inviteUrl || "");
      await refreshTeam();
      if (!result.emailSent) setNotice(t("team.copyInvite"));
    });
  };
  const revokeInvite = (id) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshTeam();
  }, t("team.inviteRevoked"));
  const changeRole = (userId, role) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}/role`, { method: "PATCH", body: { role } });
    await refreshTeam();
  });
  const removeMember = (userId) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
    await refreshTeam();
  }, t("team.memberRemoved"));
  const createBot = (e) => {
    e.preventDefault();
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}/bots`, { method: "POST", body: { name: botName, description: botDescription, instructions: botInstructions } });
      setBotName(""); setBotDescription(""); setBotInstructions("");
      await refreshTeam(teamId);
    }, t("team.botCreated"));
  };
  const createConversation = (e) => {
    e.preventDefault();
    return run(async () => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/conversations`, { method: "POST", body: { botId: selectedBotId, title: conversationTitle, visibility: conversationVisibility } });
      setConversationTitle(""); setActiveConversationId(result.conversation.id);
      await refreshTeam(teamId);
    }, t("team.conversationCreated"));
  };
  const sendMessage = (e) => {
    e.preventDefault();
    if (!activeConversation) return;
    return run(async () => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/conversations/${encodeURIComponent(activeConversation.id)}/messages`, { method: "POST", body: { content: messageDraft } });
      setMessages((items) => [...items, result.message]); setJobs((items) => [result.job, ...items]); setMessageDraft("");
    });
  };
  const saveModelConfig = (e) => {
    e.preventDefault();
    return run(async () => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/model-config`, { method: "PUT", body: { model: modelName, apiKey: modelApiKey } });
      setModelConfig(result.modelConfig); setModelApiKey("");
    }, t("team.modelSaved"));
  };
  const deleteModelConfig = () => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/model-config`, { method: "DELETE" });
    setModelConfig({ configured: false }); setModelApiKey("");
  }, t("team.modelDeleted"));
  const saveModelPolicy = (e) => {
    e.preventDefault();
    return run(async () => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy`, { method: "PUT", body: { mode: policyMode, allowedModels: policyModels } });
      setModelPolicy(result.modelPolicy);
    }, t("team.modelPolicySaved"));
  };
  const saveMemberModel = (e) => {
    e.preventDefault();
    return run(async () => {
      const result = await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy/model`, { method: "PUT", body: { model: memberModel } });
      setModelPolicy(result.modelPolicy);
      setMemberModel(result.modelPolicy?.memberModel || "");
    }, t("team.modelPolicyModelSaved"));
  };
  const addPolicyRule = (e) => {
    e.preventDefault();
    const ruleName = newRuleName.trim();
    if (!ruleName) return;
    const blockedModels = newRuleBlocked.split(/[,\uFF0C]/).map((s) => s.trim()).filter(Boolean);
    const rate = newRuleRate.trim();
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules`, {
        method: "POST",
        body: {
          ruleName,
          ...(blockedModels.length ? { blockedModels } : {}),
          ...(rate ? { maxRequestsPerUserPerHour: Number(rate) } : {}),
        },
      });
      setNewRuleName(""); setNewRuleBlocked(""); setNewRuleRate("");
      setPolicyRules((await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules`)).rules || []);
    }, t("team.policyRuleAdded"));
  };
  const togglePolicyRule = (rule) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(rule.id)}/enabled`, {
      method: "PUT", body: { enabled: !rule.enabled },
    });
    setPolicyRules((await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules`)).rules || []);
  }, rule.enabled ? t("team.policyRuleDisabled") : t("team.policyRuleEnabled"));
  const deletePolicyRule = (rule) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
    setPolicyRules((await api(`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules`)).rules || []);
  }, t("team.policyRuleDeleted"));
  const createProject = (e) => {
    e.preventDefault();
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}/projects`, { method: "POST", body: { name: projectName, repositoryUrl, defaultBranch } });
      setProjectName(""); setRepositoryUrl(""); setDefaultBranch("main");
      await refreshTeam(teamId);
    }, t("team.projectAdded"));
  };
  const deleteProject = (projectId) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    await refreshTeam(teamId);
  }, t("team.projectRemoved"));
  const refreshCodeTasks = (projectId) => api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/code-tasks`)
    .then((result) => setCodeTasks((current) => ({ ...current, [projectId]: result.tasks || [] })));
  const updateCodeTaskInput = (projectId, field, value) => setCodeTaskInputs((current) => ({
    ...current,
    [projectId]: { ...(current[projectId] || {}), [field]: value },
  }));
  const createCodeTask = (event, project) => {
    event.preventDefault();
    const input = codeTaskInputs[project.id] || {};
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(project.id)}/code-tasks`, {
        method: "POST",
        body: { branch: input.branch, instructions: input.instructions },
      });
      updateCodeTaskInput(project.id, "branch", "");
      updateCodeTaskInput(project.id, "instructions", "");
      await refreshCodeTasks(project.id);
    }, t("team.codeTaskCreated"));
  };
  const decideCodeTask = async (project, task, decision) => {
    const approve = decision === "approve";
    const reason = await askUser({ title: t(approve ? "team.approveCodeTask" : "team.rejectCodeTask"), body: t(approve ? "team.codeTaskApprovePrompt" : "team.codeTaskRejectPrompt"), input: true, danger: !approve });
    if (reason === null) return;
    return run(async () => {
      await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(project.id)}/code-tasks/${encodeURIComponent(task.id)}/${decision}`, {
        method: "POST",
        body: { reason },
      });
      await refreshCodeTasks(project.id);
    }, t(decision === "approve" ? "team.codeTaskApproved" : "team.codeTaskRejected"));
  };
  const cancelCodeTask = (project, task) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(project.id)}/code-tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" });
    await refreshCodeTasks(project.id);
  }, t("team.codeTaskCancelled"));
  const openProject = (projectId) => run(async () => {
    const result = await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/checkout`, { method: "POST" });
    setNotice(result.opened ? t("team.projectOpened", { branch: result.branch }) : t("team.projectReady", { path: result.path, branch: result.branch }));
  });
  const inspectProject = (projectId) => run(async () => {
    const result = await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/inspect`);
    setInspectedProjectId(projectId);
    setWorkspaceSnapshot(result);
    setRemoteComparison(null);
    setReviewTitle((current) => current || `${projects.find((project) => project.id === projectId)?.name || "Code"}: ${result.branch || "update"}`);
    setCreatedReview(null);
  });
  const saveGitCredential = (provider) => run(async () => {
    const token = provider === "github" ? githubToken : gitlabToken;
    const result = await api(`/team/teams/${encodeURIComponent(teamId)}/git-credentials/${provider}`, { method: "PUT", body: { token } });
    setGitCredentials(result.credentials);
    if (provider === "github") setGithubToken(""); else setGitlabToken("");
  }, t("team.gitCredentialSaved"));
  const deleteGitCredential = (provider) => run(async () => {
    await api(`/team/teams/${encodeURIComponent(teamId)}/git-credentials/${provider}`, { method: "DELETE" });
    await refreshTeam(teamId);
  }, t("team.gitCredentialDeleted"));
  const createReview = (project) => run(async () => {
    const result = await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(project.id)}/reviews`, {
      method: "POST",
      body: { head: workspaceSnapshot?.branch, title: reviewTitle, body: reviewBody },
    });
    setCreatedReview(result.review);
  }, t("team.reviewCreated"));
  const loadRemoteDiff = (project) => run(async () => {
    const head = workspaceSnapshot?.branch;
    if (!head) throw new Error(t("team.remoteBranchMissing"));
    const result = await api(`/team/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(project.id)}/diff?head=${encodeURIComponent(head)}`);
    setRemoteComparison({ projectId: project.id, ...result.comparison });
  });

  return html`<main class="onboard team-onboard" data-screen="team" data-invite-prefilled=${!!inviteToken}>
    <div class="onboard-col team-screen">
      <div class="team-head">
        <div class="onboard-hero"><h1>${t("team.title")}</h1><p>${t("team.subtitle")}</p></div>
        <button type="button" class="text" onClick=${onBack}>${t("team.back")}</button>
      </div>
      ${error && html`<${Notice} tone="red">${error}<//>`}
      ${notice && html`<${Notice}>${notice}<//>`}
      ${!status && html`<div class="team-card team-loading"><${Spinner} /> ${t("team.loading")}</div>`}
      ${status && html`<details class="team-card list team-server-settings" open=${!status.configured || !!status.error}>
        <summary>${t("team.serverTitle")}</summary>
        <form onSubmit=${configure}>
          <p class="hint">${status.error || t("team.serverHint")}</p>
          <label class="k" for="team-api-url">${t("team.serverUrl")}</label>
          <input class="field" id="team-api-url" type="url" autocomplete="url" placeholder="https://team.example.com" value=${apiBaseUrl} onInput=${(e) => setApiBaseUrl(e.target.value)} />
          <p class="hint">${t("team.serverSecurity")}</p>
          <button class="btn primary block" type="submit" disabled=${busy}>${busy ? t("team.saving") : t("team.saveServer")}</button>
        </form>
      </details>`}
      ${status?.configured && !status.signedIn && html`<section class="team-card list">
        <p class="hint">${t("team.identityHint")}</p>
        <label class="k" for="team-email">${t("team.email")}</label>
        <input class="field" id="team-email" type="email" autocomplete="email" value=${email} onInput=${(e) => setEmail(e.target.value)} />
        <button class="btn" type="button" disabled=${busy || !email.trim()} onClick=${requestCode}>${busy ? t("team.sending") : t("team.requestCode")}</button>
        <label class="k" for="team-code">${t("team.code")}</label>
        <input class="field mono" id="team-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value=${code} onInput=${(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        <button class="btn primary block" type="button" disabled=${busy || code.length !== 6 || !email.trim()} onClick=${signIn}>${busy ? t("team.signingIn") : t("team.signIn")}</button>
      </section>`}
      ${status?.signedIn && html`<section class="team-card list">
        <div class="team-identity"><div><b>${status.user?.email}</b><p class="hint">${t("team.signedInHint")}</p></div><button type="button" class="text" disabled=${busy} onClick=${signOut}>${t("team.signOut")}</button></div>
        <form class="team-form-row" onSubmit=${acceptInvite}>
          <label class="k" for="team-invite-token">${t("team.inviteToken")}</label>
          <input class="field" id="team-invite-token" autocomplete="off" placeholder=${t("team.invitePlaceholder")} value=${inviteToken} onInput=${(e) => setInviteToken(e.target.value)} />
          <button class="btn" type="submit" disabled=${busy || !inviteToken.trim()}>
            ${busy && html`<${Spinner} />`}${t("team.join")}
          </button>
        </form>
        <div class="team-form-row">
          <label class="k" for="team-select">${t("team.yourTeams")}</label>
          ${status.teams?.length ? html`<select id="team-select" class="field" value=${teamId} onChange=${(e) => setTeamId(e.target.value)}>${status.teams.map((team) => html`<option value=${team.id}>${team.name} · ${t(`team.role.${team.role}`)}</option>`)}</select>` : html`<p class="hint">${t("team.noTeams")}</p>`}
        </div>
        ${owner && selectedTeam && html`<div class="team-form-row"><button class="text danger" type="button" disabled=${busy} onClick=${deleteTeam}>${t("team.deleteTeam")}</button></div>`}
        ${selectedTeam && html`<div class="team-form-row"><button class="text danger" type="button" disabled=${busy} onClick=${leaveTeam}>${t("team.leaveTeam")}</button></div>`}
      </section>`}
      ${status?.signedIn && html`<details class="team-card list team-create-settings" open=${!status.teams?.length}>
        <summary>${t("team.createTitle")}</summary>
        <form class="team-form-row" onSubmit=${createTeam}>
          <label class="k" for="team-name">${t("team.createTitle")}</label>
          <input class="field" id="team-name" maxlength="80" value=${teamName} onInput=${(e) => setTeamName(e.target.value)} />
          <button class="btn primary" type="submit" disabled=${busy || !teamName.trim()}>${t("team.create")}</button>
        </form>
      </details>`}
      ${status?.signedIn && selectedTeam && html`<section class="team-card list">
        <div class="team-section-head"><b>${t("team.members", { count: members.length })}</b><span class="team-role">${t(`team.role.${selectedTeam.role}`)}</span></div>
        ${members.map((member) => html`<div class="team-member">
          <span class="team-member-email">${member.email}</span>
          ${canManage && member.userId !== status.user?.id && (owner || (member.role !== "owner" && member.role !== "admin")) && html`<select class="field team-role-select" aria-label=${t("team.memberRole", { email: member.email })} value=${member.role} onChange=${(e) => changeRole(member.userId, e.target.value)}>
            ${owner && html`<option value="owner">${t("team.role.owner")}</option><option value="admin">${t("team.role.admin")}</option>`}
            <option value="developer">${t("team.role.developer")}</option><option value="viewer">${t("team.role.viewer")}</option>
          </select>`}
          ${canManage && member.userId !== status.user?.id && (owner || (member.role !== "owner" && member.role !== "admin")) && html`<button class="text danger" type="button" disabled=${busy} onClick=${() => removeMember(member.userId)}>${t("team.remove")}</button>`}
          ${(!canManage || member.userId === status.user?.id || (!owner && (member.role === "owner" || member.role === "admin"))) && html`<span class="team-role">${t(`team.role.${member.role}`)}</span>`}
        </div>`)}
        ${canManage && html`<form class="team-form-row" onSubmit=${createInvite}>
          <label class="k" for="team-invite-email">${t("team.inviteMember")}</label>
          <input class="field" id="team-invite-email" type="email" autocomplete="email" placeholder=${t("team.email")} value=${inviteEmail} onInput=${(e) => setInviteEmail(e.target.value)} />
          <select class="field" aria-label=${t("team.inviteRole")} value=${inviteRole} onChange=${(e) => setInviteRole(e.target.value)}>
            ${owner && html`<option value="admin">${t("team.role.admin")}</option>`}
            <option value="developer">${t("team.role.developer")}</option><option value="viewer">${t("team.role.viewer")}</option>
          </select>
          <button class="btn primary" type="submit" disabled=${busy || !inviteEmail.trim()}>
            ${busy && html`<${Spinner} />`}${t("team.invite")}
          </button>
          ${inviteUrl && html`<div class="team-invite-link"><span>${inviteUrl}</span><${CopyButton} text=${inviteUrl} label=${t("team.copyInviteLink")} /></div>`}
        </form>`}
      </section>`}
      ${status?.signedIn && canManage && html`<section class="team-card list">
        <div class="team-section-head"><b>${t("team.openInvitations")}</b></div>
        ${invitations.map((invite) => html`<div class="team-member"><span class="team-member-email">${invite.email}<small>${t(`team.role.${invite.role}`)}</small></span><button class="text danger" type="button" disabled=${busy} onClick=${() => revokeInvite(invite.id)}>${t("team.revoke")}</button></div>`)}
        ${!invitations.length && html`<p class="hint">${t("team.noInvitations")}</p>`}
      </section>`}
      ${status?.signedIn && selectedTeam && canManage && html`<details class="team-card list team-audit">
        <summary>${t("team.auditTitle", { count: auditEvents.length })}</summary>
        <div class="team-audit-actions"><button class="btn" type="button" disabled=${busy} onClick=${() => run(async () => {
          const result = await api(`/team/teams/${encodeURIComponent(teamId)}/audit`);
          setAuditEvents(result.events || []);
        })}>${t("team.refreshAudit")}</button></div>
        ${auditEvents.map((event) => html`<article class="team-audit-event">
          <div><b>${auditLabel(event.action)}</b><time>${new Date(event.createdAt).toLocaleString()}</time></div>
          <p>${t("team.auditActorTarget", { actor: event.actorEmail || t("team.systemActor"), target: `${event.targetType}:${event.targetId}` })}</p>
          ${Object.keys(event.details || {}).length > 0 && html`<code>${JSON.stringify(event.details).slice(0, 500)}</code>`}
        </article>`)}
        ${!auditEvents.length && html`<p class="hint">${t("team.noAuditEvents")}</p>`}
      </details>`}
      ${status?.signedIn && selectedTeam && html`<section class="team-card list team-workspace">
        <div class="team-section-head"><b>${t("team.workspaceTitle")}</b><span class="team-role">${t("team.sharedWorkspace")}</span></div>
        <p class="hint">${t("team.workspaceHint")}</p>
        ${canManage && html`<details class="team-card list team-nested-card" open=${!modelConfig?.configured}>
          <summary>${t("team.modelSettings")}</summary>
          <p class="hint">${modelConfig?.configured ? t("team.modelConfigured", { model: modelConfig.model, tail: modelConfig.keyTail }) : t("team.modelMissing")}</p>
          ${modelConfig?.modelBaseUrl && html`<p class="hint">${t("team.modelEndpoint", { url: modelConfig.modelBaseUrl })}</p>`}
          <form class="team-form-row" onSubmit=${saveModelConfig}>
            <label class="k" for="team-model-name">${t("team.modelName")}</label>
            <input class="field" id="team-model-name" maxlength="120" value=${modelName} onInput=${(e) => setModelName(e.target.value)} />
            <label class="k" for="team-model-key">${t("team.modelKey")}</label>
            <input class="field" id="team-model-key" type="password" autocomplete="new-password" value=${modelApiKey} onInput=${(e) => setModelApiKey(e.target.value)} />
            <p class="hint">${t("team.modelKeySecurity")}</p>
            <button class="btn primary" type="submit" disabled=${busy || !modelName.trim() || !modelApiKey.trim()}>${t("team.saveModel")}</button>
            ${modelConfig?.configured && html`<button class="text danger" type="button" disabled=${busy} onClick=${deleteModelConfig}>${t("team.deleteModel")}</button>`}
          </form>
        </details>`}
        ${modelPolicy && html`<details class="team-card list team-nested-card">
          <summary>${t("team.modelPolicyTitle")}</summary>
          <p class="hint">${t("team.modelPolicyHint")}</p>
          ${canManage ? html`<form class="team-form-row" onSubmit=${saveModelPolicy}>
            <label class="k" for="team-policy-mode">${t("team.modelPolicyMode")}</label>
            <select class="field" id="team-policy-mode" value=${policyMode} onChange=${(e) => setPolicyMode(e.target.value)}>
              <option value="all">${t("team.modelPolicyModeAll")}</option>
              <option value="catalog" disabled=${!modelPolicy.catalogModels?.length}>${t("team.modelPolicyModeCatalog")}</option>
              <option value="allowlist">${t("team.modelPolicyModeAllowlist")}</option>
            </select>
            <p class="hint">${policyMode === "catalog" ? t("team.modelPolicyModeCatalogHint") : policyMode === "allowlist" ? t("team.modelPolicyModeAllowlistHint") : t("team.modelPolicyModeAllHint")}</p>
            ${!modelPolicy.catalogModels?.length && html`<p class="hint">${t("team.modelPolicyNoModels")}</p>`}
            ${policyMode === "allowlist" && html`<>
              <label class="k">${t("team.modelPolicyModels")}</label>
              <p class="hint">${t("team.modelPolicyModelsHint")}</p>
              ${modelPolicy.catalogModels?.map((model) => html`<label class="team-policy-model">
                <input type="checkbox" checked=${policyModels.includes(model)} onChange=${(e) => setPolicyModels((current) => e.target.checked ? [...current, model] : current.filter((item) => item !== model))} />
                <span>${model}</span>
              </label>`)}
              ${!modelPolicy.catalogModels?.length && html`<p class="hint">${t("team.modelPolicyNoModels")}</p>`}
            </>`}
            <button class="btn primary" type="submit" disabled=${busy || (policyMode === "allowlist" && !policyModels.length)}>${t("team.modelPolicySave")}</button>
          </form>` : html`<p class="hint">${t(`team.modelPolicyMode${policyMode.charAt(0).toUpperCase()}${policyMode.slice(1)}`)}</p>`}
          ${modelPolicy.memberModel && html`<p class="hint">${t("team.modelPolicyCurrent", { model: modelPolicy.memberModel })}</p>`}
          <form class="team-form-row" onSubmit=${saveMemberModel}>
            <label class="k" for="team-member-model">${t("team.modelPolicyModelLabel")}</label>
            <select class="field" id="team-member-model" value=${memberModel} onChange=${(e) => setMemberModel(e.target.value)}>
              <option value="">${t("team.modelPolicyModelDefault")}</option>
              ${modelPolicy.availableModels?.map((model) => html`<option value=${model}>${model}</option>`)}
            </select>
            <p class="hint">${t("team.modelPolicyModelHint")}</p>
            <button class="btn primary" type="submit" disabled=${busy}>${t("team.modelPolicySave")}</button>
          </form>
        </details>`}
        ${html`<details class="team-card list team-nested-card">
          <summary>${t("team.policyRulesTitle")}</summary>
          <p class="hint">${t("team.policyRulesHint")}</p>
          ${policyRules.length ? policyRules.map((rule) => html`<div class="team-policy-rule">
            <div class="grow">
              <div class="team-section-head"><b>${rule.ruleName}</b><span class="team-role">${rule.enabled ? t("team.policyRuleActive") : t("team.policyRuleInactive")}</span></div>
              <p class="hint">${t("team.policyRuleRoles", { roles: rule.appliesToRoles?.length ? rule.appliesToRoles.join(", ") : t("team.policyRuleAllRoles") })}</p>
              ${rule.maxRequestsPerUserPerHour ? html`<p class="hint">${t("team.policyRuleUserRate", { count: rule.maxRequestsPerUserPerHour })}</p>` : null}
              ${rule.maxRequestsPerTeamPerHour ? html`<p class="hint">${t("team.policyRuleTeamRate", { count: rule.maxRequestsPerTeamPerHour })}</p>` : null}
              ${rule.maxTotalTokensPerUserPerDay ? html`<p class="hint">${t("team.policyRuleDailyTokens", { count: rule.maxTotalTokensPerUserPerDay })}</p>` : null}
              ${rule.blockedModels?.length ? html`<p class="hint">${t("team.policyRuleBlocked", { models: rule.blockedModels.join(", ") })}</p>` : null}
              ${rule.allowedModels?.length ? html`<p class="hint">${t("team.policyRuleAllowed", { models: rule.allowedModels.join(", ") })}</p>` : null}
            </div>
            ${canManage ? html`<div class="team-policy-rule-actions">
              <button class="text" type="button" disabled=${busy} onClick=${() => togglePolicyRule(rule)}>${rule.enabled ? t("team.policyRuleDisable") : t("team.policyRuleEnable")}</button>
              <button class="text danger" type="button" disabled=${busy} onClick=${() => deletePolicyRule(rule)}>${t("team.policyRuleDelete")}</button>
            </div>` : null}
          </div>`) : html`<p class="hint">${t("team.policyRuleNone")}</p>`}
          ${canManage ? html`<form class="team-form-row" onSubmit=${addPolicyRule}>
            <label class="k" for="team-rule-name">${t("team.policyRuleName")}</label>
            <input class="field" id="team-rule-name" value=${newRuleName} onInput=${(e) => setNewRuleName(e.target.value)} placeholder=${t("team.policyRuleNamePlaceholder")} />
            <label class="k" for="team-rule-blocked">${t("team.policyRuleBlockedLabel")}</label>
            <input class="field" id="team-rule-blocked" value=${newRuleBlocked} onInput=${(e) => setNewRuleBlocked(e.target.value)} placeholder=${t("team.policyRuleBlockedPlaceholder")} />
            <label class="k" for="team-rule-rate">${t("team.policyRuleRateLabel")}</label>
            <input class="field" id="team-rule-rate" type="number" min="1" value=${newRuleRate} onInput=${(e) => setNewRuleRate(e.target.value)} placeholder=${t("team.policyRuleRatePlaceholder")} />
            <button class="btn primary" type="submit" disabled=${busy || !newRuleName.trim()}>${t("team.policyRuleAdd")}</button>
          </form>` : null}
          ${policyViolations.length ? html`<div class="team-section-head"><b>${t("team.policyViolationsTitle")}</b></div>
            ${policyViolations.slice(0, 20).map((violation) => html`<div class="team-usage-member">
              <span>${violation.userEmail || t("team.policyViolationUnknownUser")}</span>
              <span>${violation.ruleName || violation.violationType}${violation.modelRequested ? " · " + violation.modelRequested : ""}</span>
            </div>`)}` : null}
        </details>`}
        ${usage && html`<section class="team-usage" aria-label=${t("team.usageTitle")}>
          <div class="team-section-head"><b>${t("team.usageTitle")}</b><span class="team-role">${t("team.usageSince", { date: new Date(usage.periodStart).toLocaleDateString() })}</span></div>
          <p class="hint">${t("team.usageSummary", { jobs: usage.successfulJobs, reported: usage.reportedJobs, input: usage.inputTokens.toLocaleString(), output: usage.outputTokens.toLocaleString() })}</p>
          ${usage.scope === "team" && usage.members.map((member) => html`<div class="team-usage-member"><span>${member.email}</span><span>${t("team.usageMemberSummary", { jobs: member.successfulJobs, reported: member.reportedJobs, input: member.inputTokens.toLocaleString(), output: member.outputTokens.toLocaleString() })}</span></div>`)}
          <p class="hint">${t("team.usageBillingNote")}</p>
        </section>`}
        <div class="team-section-head"><b>${t("team.botsTitle", { count: bots.length })}</b></div>
        ${bots.map((bot) => html`<div class="team-member"><span class="team-member-email"><b>${bot.name}</b>${bot.description && html`<small>${bot.description}</small>`}</span><span class="team-role">${t("team.shared")}</span></div>`)}
        ${!bots.length && html`<p class="hint">${t("team.noBots")}</p>`}
        ${canManage && html`<details class="team-card list team-nested-card">
          <summary>${t("team.createBot")}</summary>
          <form class="team-form-row" onSubmit=${createBot}>
            <label class="k" for="team-bot-name">${t("team.botName")}</label>
            <input class="field" id="team-bot-name" maxlength="80" value=${botName} onInput=${(e) => setBotName(e.target.value)} />
            <label class="k" for="team-bot-description">${t("team.botDescription")}</label>
            <input class="field" id="team-bot-description" maxlength="4000" value=${botDescription} onInput=${(e) => setBotDescription(e.target.value)} />
            <label class="k" for="team-bot-instructions">${t("team.botInstructions")}</label>
            <textarea class="field" id="team-bot-instructions" rows="4" maxlength="12000" value=${botInstructions} onInput=${(e) => setBotInstructions(e.target.value)}></textarea>
            <p class="hint">${t("team.botInstructionSecurity")}</p>
            <button class="btn primary" type="submit" disabled=${busy || !botName.trim()}>${t("team.createBot")}</button>
          </form>
        </details>`}
        ${bots.length > 0 && canDevelop && html`<form class="team-form-row" onSubmit=${createConversation}>
          <label class="k" for="team-new-conversation">${t("team.newConversation")}</label>
          <input class="field" id="team-new-conversation" maxlength="120" placeholder=${t("team.conversationTitle")} value=${conversationTitle} onInput=${(e) => setConversationTitle(e.target.value)} />
          <select class="field" aria-label=${t("team.chooseBot")} value=${selectedBotId} onChange=${(e) => setSelectedBotId(e.target.value)}>
            ${bots.map((bot) => html`<option value=${bot.id}>${bot.name}</option>`)}
          </select>
          <select class="field" aria-label=${t("team.visibility")} value=${conversationVisibility} onChange=${(e) => setConversationVisibility(e.target.value)}>
            <option value="team">${t("team.visibilityTeam")}</option><option value="private">${t("team.visibilityPrivate")}</option>
          </select>
          <button class="btn" type="submit" disabled=${busy || !conversationTitle.trim() || !selectedBotId}>${t("team.createConversation")}</button>
        </form>`}
        ${conversations.length > 0 && html`<div class="team-chat">
          <label class="k" for="team-conversation-select">${t("team.conversationsTitle")}</label>
          <select class="field" id="team-conversation-select" value=${activeConversationId} onChange=${(e) => setActiveConversationId(e.target.value)}>
            ${conversations.map((conversation) => html`<option value=${conversation.id}>${conversation.title} · ${conversation.botName} · ${conversation.visibility === "team" ? t("team.visibilityTeam") : t("team.visibilityPrivate")}</option>`)}
          </select>
          <div class="team-chat-messages" aria-live="polite">
            ${messages.map((message) => html`<article class="team-chat-message"><div><b>${message.authorEmail}</b><time>${new Date(message.createdAt).toLocaleString()}</time></div><p>${message.content}</p></article>`)}
            ${!messages.length && html`<p class="hint">${t("team.noMessages")}</p>`}
          </div>
          ${jobs.slice(0, 3).map((job) => html`<p class="team-job-status" data-state=${job.status}>${t(`team.job.${job.status}`)}${(job.status === "failed" || job.status === "cancelled") && job.errorCode ? html` · ${jobErrorLabel(job.errorCode)}` : ""}</p>`)}
          ${activeConversation && (activeConversation.visibility === "team" || activeConversation.createdBy === status.user?.id) && canDevelop && html`<form class="team-form-row" onSubmit=${sendMessage}>
            <label class="k" for="team-message">${t("team.messageLabel")}</label>
            <textarea class="field" id="team-message" rows="3" maxlength="20000" value=${messageDraft} onInput=${(e) => setMessageDraft(e.target.value)}></textarea>
            <button class="btn primary" type="submit" disabled=${busy || !messageDraft.trim()}>${t("team.sendMessage")}</button>
          </form>`}
        </div>`}
      </section>`}
      ${status?.signedIn && selectedTeam && html`<section class="team-card list team-projects">
        <div class="team-section-head"><b>${t("team.projectsTitle", { count: projects.length })}</b></div>
        <p class="hint">${t("team.projectsHint")}</p>
        ${projects.map((project) => html`<article class="team-project">
          <div class="team-project-head"><div><b>${project.name}</b><span class="team-role">${project.provider === "github" ? "GitHub" : "GitLab"} · ${t("team.defaultBranch", { branch: project.defaultBranch })}</span></div>
            <a href=${project.repositoryUrl} target="_blank" rel="noreferrer">${t("team.openRepository")}</a></div>
          <code>${project.cloneUrl}</code>
          <div class="team-project-actions"><${CopyButton} text=${`git clone ${project.cloneUrl}`} label=${t("team.copyCloneCommand")} />
            <button class="btn" type="button" disabled=${busy} onClick=${() => openProject(project.id)}>${t("team.cloneOnThisComputer")}</button>
            <button class="btn" type="button" disabled=${busy} onClick=${() => inspectProject(project.id)}>${t("team.inspectLocalChanges")}</button>
            ${canManage && html`<button class="text danger" type="button" disabled=${busy} onClick=${() => deleteProject(project.id)}>${t("team.removeProject")}</button>`}
          </div>
          ${inspectedProjectId === project.id && workspaceSnapshot && html`<details class="team-workspace-review" open>
            <summary>${t("team.localChanges")}</summary>
            ${!workspaceSnapshot.available ? html`<p class="hint">${t("team.localWorkspaceMissing")}</p>` : html`<>
              <p class="hint">${t("team.localBranch", { branch: workspaceSnapshot.branch || "(detached)" })}</p>
              ${workspaceSnapshot.reviewUrl && html`<a href=${workspaceSnapshot.reviewUrl} target="_blank" rel="noreferrer">${t(project.provider === "github" ? "team.openCompare" : "team.openMergeRequest")}</a>`}
              ${workspaceSnapshot.files.length ? html`<ul class="team-change-files">${workspaceSnapshot.files.map((file) => html`<li><code>${file.status}</code> <span>${file.path}</span></li>`)}</ul>` : html`<p class="hint">${t("team.noLocalChanges")}</p>`}
              ${workspaceSnapshot.filesTruncated && html`<p class="hint">${t("team.changeListTruncated")}</p>`}
              ${workspaceSnapshot.diff && html`<pre class="team-diff-preview">${workspaceSnapshot.diff}</pre>`}
              ${workspaceSnapshot.diffTruncated && html`<p class="hint">${t("team.diffTruncated")}</p>`}
              ${canDevelop && workspaceSnapshot.branch && gitCredentials[project.provider]?.configured && html`<button class="btn" type="button" disabled=${busy} onClick=${() => loadRemoteDiff(project)}>${t("team.loadCommittedDiff")}</button>`}
              ${remoteComparison?.projectId === project.id && html`<div class="team-remote-diff"><p class="hint">${t("team.remoteDiffRange", { head: remoteComparison.head, base: remoteComparison.base })}</p><pre class="team-diff-preview">${remoteComparison.diff || t("team.noCommittedDiff")}</pre>${remoteComparison.truncated && html`<p class="hint">${t("team.remoteDiffTruncated")}</p>`}</div>`}
              ${canDevelop && workspaceSnapshot.branch && gitCredentials[project.provider]?.configured && html`<form class="team-review-form" onSubmit=${(e) => { e.preventDefault(); void createReview(project); }}>
                <label class="k" for=${`team-review-title-${project.id}`}>${t("team.reviewTitle")}</label>
                <input class="field" id=${`team-review-title-${project.id}`} maxlength="240" value=${reviewTitle} onInput=${(e) => setReviewTitle(e.target.value)} />
                <label class="k" for=${`team-review-body-${project.id}`}>${t("team.reviewDescription")}</label>
                <textarea class="field" id=${`team-review-body-${project.id}`} maxlength="20000" rows="3" value=${reviewBody} onInput=${(e) => setReviewBody(e.target.value)}></textarea>
                <button class="btn primary" type="submit" disabled=${busy || !reviewTitle.trim()} >${t(project.provider === "github" ? "team.createPullRequest" : "team.createMergeRequest")}</button>
              </form>`}
              ${createdReview && inspectedProjectId === project.id && html`<p><a href=${createdReview.url} target="_blank" rel="noreferrer">${t("team.openCreatedReview", { number: createdReview.number ? `#${createdReview.number}` : createdReview.title })}</a></p>`}
            </>`}
          </details>`}
          <section class="team-code-tasks" aria-label=${t("team.codeTasksTitle")}>
            <div class="team-section-head"><b>${t("team.codeTasksTitle")}</b><span class="team-role">${t("team.codeTasksProtocol")}</span></div>
            <p class="hint">${t("team.codeTasksHint")}</p>
            ${(codeTasks[project.id] || []).map((task) => html`<article class="team-code-task">
              <div class="team-project-head"><div><b>${t(`team.codeTaskStatus.${task.status}`)}</b><span class="team-role">${new Date(task.createdAt).toLocaleString()}</span></div><span class="team-role">${task.branch}</span></div>
              <p class="hint">${task.instructions}</p>
              ${task.decisionReason && html`<p class="hint">${t("team.codeTaskReason", { reason: task.decisionReason })}</p>`}
              ${task.executorResult && html`<pre class="team-diff-preview">${t("team.codeTaskResult")}: ${task.executorResult}</pre>`}
              ${task.executorError && html`<p class="hint">${t("team.codeTaskError", { error: task.executorError })}</p>`}
              <div class="team-project-actions">
                ${canManage && task.status === "pending_approval" && html`<button class="btn" type="button" disabled=${busy} onClick=${() => decideCodeTask(project, task, "approve")}>${t("team.approveCodeTask")}</button><button class="text danger" type="button" disabled=${busy} onClick=${() => decideCodeTask(project, task, "reject")}>${t("team.rejectCodeTask")}</button>`}
                ${((task.createdBy === status.user?.id) || canManage) && ["pending_approval", "approved_waiting_executor", "dispatching", "running"].includes(task.status) && html`<button class="text danger" type="button" disabled=${busy} onClick=${() => cancelCodeTask(project, task)}>${t("team.cancelCodeTask")}</button>`}
              </div>
            </article>`)}
            ${!(codeTasks[project.id] || []).length && html`<p class="hint">${t("team.noCodeTasks")}</p>`}
            ${canDevelop && html`<form class="team-form-row" onSubmit=${(event) => createCodeTask(event, project)}>
              <label class="k" for=${`team-code-task-branch-${project.id}`}>${t("team.codeTaskBranch")}</label>
              <input class="field mono" id=${`team-code-task-branch-${project.id}`} maxlength="240" placeholder=${project.defaultBranch} value=${codeTaskInputs[project.id]?.branch || ""} onInput=${(e) => updateCodeTaskInput(project.id, "branch", e.target.value)} />
              <label class="k" for=${`team-code-task-instructions-${project.id}`}>${t("team.codeTaskInstructions")}</label>
              <textarea class="field" id=${`team-code-task-instructions-${project.id}`} rows="3" maxlength="20000" value=${codeTaskInputs[project.id]?.instructions || ""} onInput=${(e) => updateCodeTaskInput(project.id, "instructions", e.target.value)}></textarea>
              <button class="btn" type="submit" disabled=${busy || !codeTaskInputs[project.id]?.branch?.trim() || !codeTaskInputs[project.id]?.instructions?.trim()}>${t("team.createCodeTask")}</button>
            </form>`}
          </section>
        </article>`)}
        ${!projects.length && html`<p class="hint">${t("team.noProjects")}</p>`}
        ${canManage && html`<details class="team-card list team-nested-card">
          <summary>${t("team.addProject")}</summary>
          <form class="team-form-row" onSubmit=${createProject}>
            <label class="k" for="team-project-name">${t("team.projectName")}</label>
            <input class="field" id="team-project-name" maxlength="80" value=${projectName} onInput=${(e) => setProjectName(e.target.value)} />
            <label class="k" for="team-repository-url">${t("team.repositoryUrl")}</label>
            <input class="field" id="team-repository-url" type="url" placeholder="https://github.com/owner/repository" value=${repositoryUrl} onInput=${(e) => setRepositoryUrl(e.target.value)} />
            <label class="k" for="team-default-branch">${t("team.defaultBranchLabel")}</label>
            <input class="field mono" id="team-default-branch" maxlength="120" value=${defaultBranch} onInput=${(e) => setDefaultBranch(e.target.value)} />
            <button class="btn primary" type="submit" disabled=${busy || !projectName.trim() || !repositoryUrl.trim()}>${t("team.addProject")}</button>
          </form>
        </details>`}
      </section>`}
      ${status?.signedIn && selectedTeam && canManage && html`<section class="team-card list team-git-credentials">
        <div class="team-section-head"><b>${t("team.gitCredentialsTitle")}</b></div>
        <p class="hint">${t("team.gitCredentialsHint")}</p>
        ${["github", "gitlab"].map((provider) => html`<form class="team-form-row" onSubmit=${(e) => { e.preventDefault(); void saveGitCredential(provider); }}>
          <label class="k" for=${`team-git-token-${provider}`}>${provider === "github" ? "GitHub" : "GitLab"} ${gitCredentials[provider]?.configured ? t("team.credentialConfigured", { tail: gitCredentials[provider].keyTail || "" }) : t("team.credentialNotConfigured")}</label>
          <input class="field" id=${`team-git-token-${provider}`} type="password" autocomplete="new-password" maxlength="4096" value=${provider === "github" ? githubToken : gitlabToken} onInput=${(e) => provider === "github" ? setGithubToken(e.target.value) : setGitlabToken(e.target.value)} placeholder=${t("team.gitTokenPlaceholder")} />
          <div class="team-project-actions"><button class="btn" type="submit" disabled=${busy || !(provider === "github" ? githubToken : gitlabToken).trim()}>${t("team.saveGitToken")}</button>
            ${gitCredentials[provider]?.configured && html`<button class="text danger" type="button" disabled=${busy} onClick=${() => deleteGitCredential(provider)}>${t("team.removeGitToken")}</button>`}</div>
        </form>`)}
      </section>`}
      ${status?.signedIn && html`<${Notice}>${t("team.previewNotice")}<//>`}
    </div>
    ${ask && html`<${Sheet} title=${ask.title} onClose=${() => closeAsk(null)}>
      <form onSubmit=${(e) => { e.preventDefault(); if (!ask.match || askValue === ask.match) closeAsk(ask.input ? askValue : ""); }}>
        <p class="body">${ask.body}</p>
        ${ask.input && html`<input class="field" data-autofocus autocomplete="off" aria-label=${ask.title} maxlength="4000" value=${askValue} onInput=${(e) => setAskValue(e.target.value)} />`}
        <div class="actions">
          <${Button} data-autofocus=${ask.input ? undefined : true} onClick=${() => closeAsk(null)}>${t("common.cancel")}<//>
          <${Button} type="submit" variant=${ask.danger ? "danger" : "primary"} disabled=${!!ask.match && askValue !== ask.match}>${t("common.confirm")}<//>
        </div>
      </form>
    <//>`}
  </main>`;
}
