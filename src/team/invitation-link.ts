const INVITATION_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export function parseTeamInvitationLink(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "dazuibot:" || url.hostname !== "invite" || (url.pathname !== "" && url.pathname !== "/") ||
      url.username || url.password || url.port || url.hash) return undefined;
  const tokens = url.searchParams.getAll("token");
  const extras = [...url.searchParams.keys()].filter((key) => key !== "token");
  if (tokens.length !== 1 || extras.length || !INVITATION_TOKEN.test(tokens[0]!)) return undefined;
  return tokens[0];
}

export function teamInvitationLink(token: string): string {
  if (!INVITATION_TOKEN.test(token)) throw new Error("Invalid team invitation token");
  return `dazuibot://invite?token=${encodeURIComponent(token)}`;
}
