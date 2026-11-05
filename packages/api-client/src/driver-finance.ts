import type { ConfirmDriverNonpayment, DriverCompensationHistory, DriverCompensationTerms, DriverEarningSummary,
  DriverEarningsPage, DriverPaymentsPage, DriverFinanceCapabilities, DriverPaymentDiscrepancy, DriverPaymentEvidence, DriverPaymentSummary, PlatformEarning,
  PlatformEarningsPage, PlatformPaymentDetail, PlatformPaymentsPage, PlatformRecognitionReviews, PublishDriverTerms, ReconcileDriverPayment, RecordDriverPayment, ResolveDriverPayment } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
import { AuthError } from "./auth";
function financeTransport(baseUrl: string, fetcher: typeof fetch) {
  const transport = driverTransport(baseUrl, fetcher);
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    try { return await transport<T>(path, method, body); }
    catch (error) {
      if (error instanceof AuthError && error.status === 409) throw new AuthError("validation", "Financial evidence or availability changed. Refresh the records and review them before a new action.", 409);
      throw error;
    }
  };
}
const ref = encodeURIComponent;
const page = (after?: string, driver?: string) => "?limit=20" + (after ? "&after=" + ref(after) : "") + (driver ? "&driver=" + ref(driver) : "");
export function createDriverFinanceClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = financeTransport(baseUrl, fetcher);
  return {
    own: (after?: string) => request<DriverEarningsPage>("/driver/earnings" + page(after)),
    payments: (after?: string) => request<DriverPaymentsPage>("/driver/earnings/payments" + page(after)),
    earning: (id: string) => request<DriverEarningSummary>("/driver/earnings/" + ref(id)),
    payment: (id: string) => request<DriverPaymentSummary>("/driver/earnings/payments/" + ref(id)),
  };
}
export function createPlatformDriverFinanceClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = financeTransport(baseUrl, fetcher), path = "/admin/gospaza/driver-finance";
  return {
    capabilities: () => request<DriverFinanceCapabilities>(path + "/capabilities"),
    reviews: (after?: string, driver?: string) => request<PlatformRecognitionReviews>(path + "/reviews" + page(after, driver)),
    earnings: (after?: string, driver?: string) => request<PlatformEarningsPage>(path + "/earnings" + page(after, driver)),
    earning: (id: string) => request<PlatformEarning>(path + "/earnings/" + ref(id)),
    payments: (after?: string, driver?: string) => request<PlatformPaymentsPage>(path + "/payments" + page(after, driver)),
    payment: (id: string) => request<PlatformPaymentDetail>(path + "/payments/" + ref(id)),
    evidence: (id: string) => request<DriverPaymentEvidence>("/admin/gospaza/driver-payments/" + ref(id)),
    record: (input: RecordDriverPayment, uncertain = false) => request<{ payment_id: string; command_id: string }>("/admin/gospaza/driver-payments/" + (uncertain ? "uncertain" : "record"), "POST", input),
    confirmPaid: (id: string, input: ResolveDriverPayment) => request("/admin/gospaza/driver-payments/" + ref(id) + "/confirm-paid", "POST", input),
    confirmNotPaid: (id: string, input: ConfirmDriverNonpayment) => request("/admin/gospaza/driver-payments/" + ref(id) + "/confirm-not-paid", "POST", input),
    reconcile: (id: string, input: ReconcileDriverPayment) => request("/admin/gospaza/driver-payments/" + ref(id) + "/reconcile", "POST", input),
    discrepancy: (id: string, input: DriverPaymentDiscrepancy) => request("/admin/gospaza/driver-payments/" + ref(id) + "/discrepancies", "POST", input),
    terms: (after?: string) => request<DriverCompensationHistory>("/admin/gospaza/driver-compensation" + page(after)),
    publish: (input: PublishDriverTerms) => request<DriverCompensationTerms>("/admin/gospaza/driver-compensation", "POST", input),
  };
}
