// Registers every read-only JournL tool. The invoice-creating tools are registered only
// when ENABLE_WRITE_TOOLS=true (for testing against a test company).

import { config } from "../config/index.js";
import { registerInvoiceTools } from "./invoices/index.js";
import { registerCompanyTools } from "./companies/index.js";
import { registerLedgerTools } from "./ledgers/index.js";
import { registerReportTools } from "./reports/index.js";
import { registerStatementTools } from "./statements/index.js";
import { registerVoucherTools } from "./vouchers/index.js";
import { registerGstTools } from "./gst/index.js";
import { registerInventoryTools } from "./inventory/index.js";
import { registerCustomerTools } from "./customers/index.js";

export function registerTools(server) {
  registerCompanyTools(server);
  registerLedgerTools(server);
  registerReportTools(server);
  registerStatementTools(server);
  registerVoucherTools(server);
  registerGstTools(server);
  registerInventoryTools(server);
  registerCustomerTools(server);
  if (config.enableWriteTools) registerInvoiceTools(server);
}
