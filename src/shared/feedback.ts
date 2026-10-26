export const FEEDBACK_REPOSITORY = "Yocaihua8/dsh-connect-router";
// Public application identifier, populated only after the maintainer registers the App.
export const FEEDBACK_CLIENT_ID = "Iv23lizL3FgdbhfrtQYQ";
export const ROUTER_VERSION = "0.1.0-alpha.4";
export interface FeedbackAuth {
  configured: boolean;
  connected: boolean;
  login?: string;
}
export interface FeedbackLogin {
  id: string;
  userCode: string;
  url: string;
  expiresAt: number;
  interval: number;
}
export interface FeedbackReport {
  id: string;
  title: string;
  body: string;
  repository: string;
  at: number;
  state: "preview" | "pending" | "sent" | "failed";
  url?: string;
  code?: string;
  author?: string;
}
