import { isAppError } from "@gym/core/errors";
import { documentDownloadUrl } from "@gym/core/members";
import { services } from "@/lib/services";
import { getAuthContext } from "@/lib/session";

/** Permission check, then a 60-second signed link to the private file. */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return new Response("Not found", { status: 404 });
  try {
    const { deps, storage } = services();
    const url = await documentDownloadUrl(
      deps,
      storage,
      await getAuthContext(),
      id,
    );
    return Response.redirect(url, 302);
  } catch (err) {
    if (isAppError(err))
      return new Response(err.message, { status: err.status });
    throw err;
  }
}
