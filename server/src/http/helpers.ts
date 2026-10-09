// Request and reply helpers shared by the app wiring and every route module.
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionUser } from "../services/auth.js";
import { badRequest, unauthorized } from "../services/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = "naac_session";
/** Set by the browser that asks for a sign-in link; opening the link there signs in directly. */
export const LOGIN_COOKIE = "naac_login";

/**
 * Over HTTPS cookies get the `__Host-` prefix: the browser then only accepts them from this exact
 * host (Secure, Path=/, no Domain), so a sibling subdomain cannot plant or overwrite them.
 */
export const cookieName = (base: string, secure: boolean) => (secure ? `__Host-${base}` : base);

export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest("Invalid request", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function sendFile(reply: FastifyReply, body: Buffer, filename: string, type: string, inline = false) {
  const safe = filename.replace(/[^\w.\-, ()+]+/g, "_");
  return reply
    .header("Content-Type", type)
    .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safe}"`)
    .header("X-Content-Type-Options", "nosniff")
    .send(body);
}
