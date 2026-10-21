import AddClosedSaleModal from './AddClosedSaleModal';
import { buildSalePrefillFromLead } from '../lib/salePrefill';

// Shown the moment a lead's status transitions into SOLD (whichever path
// caused it — the whole-lead disposition dropdown or a per-product quote
// reaching SOLD, in any of this app's disposition surfaces) — mandatory,
// not a dismissible nudge: a SOLD lead that never gets a real Closed Sale
// logged is exactly how leads silently vanish from Billboard/Financials
// with no visible trace. Cancelling (the form's own Cancel button, or the
// Modal's backdrop/X — both already route through this same onClose)
// reverts the status change instead of leaving an orphaned SOLD lead
// behind. Shared by every surface that can disposition a lead to SOLD —
// see each caller's own onCancelled for its revert call.
export default function SaleLogNudge({ lead, onCancelled, onLogged }) {
  return (
    <AddClosedSaleModal
      leadId={lead.id}
      prefill={buildSalePrefillFromLead(lead)}
      blockingNote="Marking this lead SOLD requires logging the sale — cancel to leave its status unchanged instead."
      onClose={onCancelled}
      onSaved={onLogged}
    />
  );
}
