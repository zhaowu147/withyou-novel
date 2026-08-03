import { installCodingEnvironment, getCodingEnvironmentStatus } from "@/lib/pi/coding-environment";
import { requireSourceAccess } from "@/lib/pi/source-permissions";
import { authorizeSourceRequest, sourceRequestErrorResponse } from "@/lib/pi/source-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await authorizeSourceRequest(request);
    const workspace = requireSourceAccess();
    return Response.json({ success: true, data: getCodingEnvironmentStatus(workspace) });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await authorizeSourceRequest(request);
    const workspace = requireSourceAccess();
    const result = installCodingEnvironment(workspace);
    return Response.json({ success: true, data: result });
  } catch (error) {
    return sourceRequestErrorResponse(error);
  }
}
