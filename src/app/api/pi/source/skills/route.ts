import { installSourceSkill, listSourceSkills } from "@/lib/pi/source-skill-manager";
import { validateSourceGrant } from "@/lib/pi/source-permissions";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    return Response.json({ success: true, data: listSourceSkills() });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await authorizeSourceRequest(request);
    validateSourceGrant(auth.workspaceId, auth.grantToken);
    const body = (await request.json()) as Record<string, unknown>;
    const skill = installSourceSkill({
      id: typeof body.id === "string" ? body.id : "",
      content: typeof body.content === "string" ? body.content : "",
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      source:
        body.source && typeof body.source === "object"
          ? {
              type: (body.source as { type?: unknown }).type === "remote" ? "remote" : "local",
              uri: typeof (body.source as { uri?: unknown }).uri === "string" ? (body.source as { uri: string }).uri : undefined,
              publisher:
                typeof (body.source as { publisher?: unknown }).publisher === "string"
                  ? (body.source as { publisher: string }).publisher
                  : undefined,
            }
          : undefined,
      publicKey: typeof body.publicKey === "string" ? body.publicKey : undefined,
      signature: typeof body.signature === "string" ? body.signature : undefined,
      resources: Array.isArray(body.resources)
        ? body.resources.flatMap((resource) => {
            if (!resource || typeof resource !== "object") return [];
            const value = resource as Record<string, unknown>;
            return typeof value.path === "string" && typeof value.content === "string"
              ? [{ path: value.path, content: value.content }]
              : [];
          })
        : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    return Response.json({ success: true, data: skill }, { status: 201 });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}
