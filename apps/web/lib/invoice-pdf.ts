import "server-only";
import { renderInvoicePdf } from "@gym/core/billing/pdf";
import { withTenant } from "@gym/db";
import { services } from "@/lib/services";

/**
 * The invoice PDF for an invoice the caller is already allowed to see. Generated once and kept
 * in private storage (the invoice is immutable, and the PDF shows no payment status).
 */
export async function invoicePdfResponse(
  tenantId: string,
  invoiceId: string,
): Promise<Response> {
  const { db, storage } = services();
  const invoice = await withTenant(db, tenantId, (tx) =>
    tx.gymInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { lines: { orderBy: { position: "asc" } } },
    }),
  );
  let bytes: Uint8Array | null = null;
  if (invoice.pdfFileId) {
    const file = await withTenant(db, tenantId, (tx) =>
      tx.fileRecord.findUnique({ where: { id: invoice.pdfFileId! } }),
    );
    if (file) {
      const res = await fetch(await storage.getUrl(file.key, 60));
      if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
    }
  }
  if (!bytes) {
    bytes = await renderInvoicePdf(invoice);
    const key = `tenants/${tenantId}/invoices/${invoice.id}.pdf`;
    const { size } = await storage.put(key, bytes, "application/pdf");
    await withTenant(db, tenantId, async (tx) => {
      const file = await tx.fileRecord.upsert({
        where: { key },
        create: {
          tenantId,
          key,
          filename: `${invoice.number.replaceAll("/", "-")}.pdf`,
          contentType: "application/pdf",
          size,
          purpose: "INVOICE_PDF",
          scanStatus: "SKIPPED",
        },
        update: { size },
      });
      await tx.gymInvoice.update({
        where: { id: invoice.id },
        data: { pdfFileId: file.id },
      });
    });
  }
  return new Response(new Blob([bytes as BlobPart]), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${invoice.number.replaceAll("/", "-")}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
