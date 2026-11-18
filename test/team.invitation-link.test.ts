import { describe, expect, it } from "vitest";
import { parseTeamInvitationLink, teamInvitationLink } from "../src/team/invitation-link.js";

const token = "invite-token_0123456789ABCDEFGHIJKLMN";

describe("team invitation deep links", () => {
  it("round-trips a valid invite and rejects malformed or ambiguous URLs", () => {
    const link = teamInvitationLink(token);
    expect(link).toBe(`dazuibot://invite?token=${token}`);
    expect(parseTeamInvitationLink(link)).toBe(token);
    expect(parseTeamInvitationLink(`DAZUIBOT://invite/?token=${token}`)).toBe(token);
    expect(parseTeamInvitationLink(`dazuibot://invite?token=${token}&next=https://attacker.example`)).toBeUndefined();
    expect(parseTeamInvitationLink(`dazuibot://invite?token=${token}&token=${token}`)).toBeUndefined();
    expect(parseTeamInvitationLink(`dazuibot://invite:88?token=${token}`)).toBeUndefined();
    expect(parseTeamInvitationLink(`dazuibot://other?token=${token}`)).toBeUndefined();
    expect(parseTeamInvitationLink(`https://teams.example/invite?token=${token}`)).toBeUndefined();
    expect(parseTeamInvitationLink("dazuibot://invite?token=short")).toBeUndefined();
    expect(() => teamInvitationLink("unsafe token")).toThrow("Invalid team invitation token");
  });
});
