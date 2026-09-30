# Yield Marketing Lead Portal API — full reference

Source: `https://yieldmarketing.leadportal.com/new_api/index.php` (fetched and
recorded 2026-09-30). This is Yield Marketing's own lead exchange/distribution
platform (a white-labeled "boberdoo"-style lead broker system, based on
response-field naming like `boberdoo.com` appearing in sample data). It is a
**separate system** from EvenFlow's own database — EvenFlow's `Vendor`/`Lead`
models do not talk to this API today. This doc exists to ground the planned
**Record Store** feature, which will let an Agency Owner buy real leads
on-demand from this exchange directly inside EvenFlow.

## 1. How the system is organized

- **Partner** = a buyer account (who receives/purchases leads). This is the
  role EvenFlow's Agencies would play if Record Store lets them buy leads —
  each Agency would likely map to one `Partner_ID` (or `Login`) in this
  system, created once via `createNewPartner`/`insertUpdatePartner`.
- **Vendor** / **Source** = where leads originate (the traffic/publisher
  side). `getVendorsAndSources` lists vendors and their sources with a cost
  per source. Not the buyer side — don't confuse with EvenFlow's own
  `Vendor` model (EvenFlow's Vendor = the third-party company sending leads
  *into* EvenFlow; this system's Vendor/Source = upstream of the *exchange
  itself*, generally irrelevant to Record Store as a buyer).
- **Lead Type** (`TYPE` / `Lead_Type`) = the product category a lead belongs
  to (integer ID). Confirmed real examples from the docs: Mortgage, Debt
  Settlement/Short, Pay Day, Auto Insurance, Home Insurance, Life
  Insurance/Calls, HVAC/HVAC Calls, Roofing/Roofing Calls, Solar, Auto and
  Home Calls, Inbound Phone. Each lead type has its own set of lead-data
  fields (e.g. Mortgage leads carry `property_value`, `loan_amount`,
  `mortgage_type`; Auto/Home/Life/HVAC/Roofing/Solar have their own
  per-type field docs not exhaustively captured here — `getPossibleSalePrice`,
  `updateLead`, `pingPostLead`, etc. all note "inputs depend on the lead
  type configuration," with dedicated sub-pages per type that this fetch
  pass did not drill into individually).
- **Filter Set** = a buyer's purchasing criteria for one lead type: price,
  geography, delivery limits, exclusivity, acceptance windows, etc. A
  Partner can have many Filter Sets across lead types (`getFilterSets`,
  `getFilterSet`, `insertUpdateFilterSet`). This is effectively "what I'm
  willing to buy and at what price" — the Record Store's browsing UI most
  likely maps to letting an Agency Owner see/configure Filter Sets (or a
  simplified subset of them) without exposing the raw API concept.
- **Ping / Post / Full** — the real-time bidding mechanic:
  - **Ping**: submit partial lead data (the lead type's "Ping Required"
    fields) to check if/how it would match and at what price, without
    committing the sale.
  - **Post**: after a ping, submit the remaining "Post Required" fields to
    actually close/process the lead.
  - **Full**: submit everything in one call (all ping + post required
    fields except `Lead_ID`), skipping the two-step flow.
  - This pattern spans `pingPostLead`, `pingPostConsent` (adds HTML broker
    offers/bids to the response), and the IPR (phone-routing) variants
    `iprSubmitLead`/`iprSubmitConsent` (`Mode=ping`/`Mode=post`).
- **IPR** (Inbound Phone Routing) = a parallel, call-centric subsystem for
  lead types that are live phone transfers rather than web-form leads
  (Auto/Home Calls, Life Calls, HVAC Calls, Roofing Calls, Inbound Phone).
  Calls are pinged/matched to a `Partner_Ring_To` phone number, then the
  telecom provider reports back call lifecycle events
  (`iprActivateCall` → `iprTerminateCall`/`iprCallFailed`) so the system can
  bill per-minute and mark success/failure. `noPingRing`/`pingRing` hand out
  a terminating phone number from a dynamic pool for IVR-driven routing
  before the lead's real data is known.
- **CRM status sync** — once a Partner has a lead, they can report back what
  happened to it via `setCRMLeadStatus` (by lead+partner), `setCRMStatusByLeadID`
  (updates *all* partners/statuses tied to that lead), `setCRMStatusByPhone`
  (updates *all* leads/partners tied to that phone number), or
  `setCRMStatusFromGoHighLevel` (phone-based, searches back 60 days,
  built for GoHighLevel CRM webhooks specifically). Real revenue can be
  attached via the optional `Revenue` field. **This is the natural
  disposition-sync point** — if Record Store leads land in EvenFlow's own
  `Lead` pipeline, EvenFlow's own disposition changes (e.g. `SOLD`) could
  call one of these to report outcome/revenue back to Yield Marketing.
- **Refunds** — a Partner can request a refund for a bad lead
  (`requestRefundForLead`, needs a `Reason_ID` from `getRefundReasons`),
  which an admin approves/declines (`processRefundRequest`), can be undone
  (`undoRefundApproved`), and can be listed (`getRefundRequests` for a
  partner, `getAllRefunds` for all requests of a partner+type). Separately,
  `undoSale`/`undoSaleAndReprocess` let an admin reverse a sale transaction
  outright (the latter also re-triggers matching, excluding the original
  partner).
- **Balance/credit** — `getPartnerCreditandBalance` returns `Balance`,
  `Credit_Limit`, `Total_Balance`, `Unlimited_Credit`. `submitPayment` adds
  or subtracts funds via typed `Operation_Type` codes (see §4). This is the
  real "how much do I owe / how much credit do I have to spend" check
  Record Store would need before letting an Agency Owner buy.

## 2. Transport & auth

- **Method**: HTTPS POST only.
- **Endpoints**:
  - General (form-encoded, works for either format via `Format` param):
    `https://yieldmarketing.leadportal.com/new_api/api.php`
  - Dedicated XML: `https://yieldmarketing.leadportal.com/apiXML.php`
  - Dedicated JSON: `https://yieldmarketing.leadportal.com/apiJSON.php`
- **Auth**: an API key created under the portal's own Settings → API Keys,
  passed as the `Key` field in every request body. No header-based auth —
  it's a POST body field like any other parameter.
- **Every request needs**: `Key`, `API_Action` (the function name, exact
  case), and optionally `Format` (`json` or `xml`, default XML).
- **Case sensitivity**: "All field names in the request are case
  sensitive" — this is explicit in the docs, worth defending against with
  strict payload-building code rather than loose object spreads.
- **Test mode**: several lead-submission endpoints (`iprSubmitLead`,
  `noPingRing`, `pingRing`, `pingPostLead` family) support a **test request**
  variant — either `?Test_Lead=1` on the URL, `<Test_Lead>1</Test_Lead>` in
  XML, or `{"Test_Lead": "1"}` in JSON — which presumably runs the same
  logic without a real charge/commit. Worth using during Record Store
  integration development.
- **PHP sample code** on the page uses `curl_init()` + `CURLOPT_POST`, a
  60-second timeout, and expects HTTP 200.

## 3. Full action catalog (73 documented actions)

Grouped by function. Every action takes `Key`, `API_Action`, and optional
`Format` in addition to what's listed. Parameters are required unless noted.

### Lead lifecycle
| Action | Purpose | Key params |
|---|---|---|
| `submitLead` | **Deprecated — "DO NOT USE."** Superseded by `pingPostLead`. | — |
| `pingPostLead` | Ping/Post/Full submission + match check for standard (non-phone) lead types. Supports `Return_Best_Price`, `Allowed_Times_Sold` response modifiers. | per lead-type ping/post field sets |
| `pingPostConsent` | Same as `pingPostLead` but returns broker IDs + HTML offers (`seller_html`, `seller_lead_bid`, `seller_phone_display`) for consent-based/co-reg style flows. | per lead-type fields |
| `updateLead` | Update fields on an existing lead (partial update, lead-type-specific fields). | `Lead_ID` (implied) + changed fields |
| `updateLeadAndDeliver` | Update, then attempt (re)delivery; response can include `warnings` (e.g. "Sale transaction for Partner_ID X not found/has been refunded"). | same |
| `updateLeadAndReprocess` | Update, then re-run matching (`status: Matched/Unmatched/Error`). | same |
| `getLeadDetails` | Fetch lead(s) by `Lead_ID` or incrementally via `Last_Lead_ID` (>, default 1); max 100 rows/call. Rich optional filters: `Partner_ID`, `Email`, `Phone`, `By_Transaction_Date`, `Include_Lead_Cost`, `Include_Best_Ping_Price`, `Date_Start`/`Date_End`, `Show_Status` (`matched,unmatched,review,pending,declined`), `Call_Status` (`active`/`complete`, IPR only), `Completed_Date_Time`, `Include_OS_Result`. | `Lead_Type` required |
| `getLeadsCRMStatus` | Same pull shape as `getLeadDetails` but response includes `matched_partners[].crm_lead_status`/`revenue`, `number_of_times_sold`, and `cross_reference_lead` (dedupe linkage). | `Lead_Type` required |
| `leadDelete` | Delete leads by `Phone_Number` and/or `Email` (comma-separated). Response reports per-lead `removed: true/false`. | `Phone_Number` or `Email` |
| `declineLead` | Decline a lead (params not fully documented in the fetched page; only `Key`/`API_Action` confirmed). | undocumented |
| `reDeliverLeads` | Re-send already-processed leads to brokers. `Lead_IDs` comma-separated. Response is per-lead, per-broker success/failure. | `TYPE`, `Lead_IDs` |
| `getNumberOfLeads` | Count of leads inserted (not sold) in a date range, optionally by `Partner_ID`, `SRC`, `Filter_Set_ID`, `Ignore_Refunds`. | `Lead_Type`, `Date_Start`, `Date_End` |

### Matching / bidding
| Action | Purpose | Key params |
|---|---|---|
| `getMatchingPartners` | Who (which buyer Partners) a given lead matched to — real partner contact info in response. | `Lead_Type`, `Lead_ID`; optional `Include_Social_Info` |
| `getMatchingSellers` | Same idea for the seller/bidding side — returns `bids[]` with `bid_id`, `seller_id`, `seller_company_name`, `seller_lead_bid`. | `Lead_Type`, `Lead_ID` |
| `getPossibleMatchingPartners` | Pre-check matching partners, optionally with `Get_Unmatched_Reasons`. Response shape not fully captured in this fetch pass. | `Lead_Type`, `Lead_ID` |
| `getPossibleSalePrice` | Submit filter-style values (lead-type-specific) and get back the would-be total sale price (`status: Matched/Unmatched/Error`, `price`). Does **not** guarantee the real price at actual submission time. | lead-type-specific filter fields |

### Filter sets (buying criteria)
| Action | Purpose | Key params |
|---|---|---|
| `getFilterSets` | List a partner's filter sets (id/type/name/status/match_priority). | `Partner_ID` |
| `getFilterSetsAll` | List every filter set in the whole system, across all partners. | none beyond auth |
| `getFilterSetsAllWithTargets` | Presumably `getFilterSetsAll` + target/geo criteria attached — response shape not captured. | none beyond auth (assumed) |
| `getFilterSet` | Full config of one filter set: `filter_set_name`, `lead_price`, `minimum_ping_price_for_delivery`, `cost_per_lead_on_filter`, `match_priority`, `exclusivity`/`exclusivity_period`, `lead_delivery_setup`, `custom_email_sender`, `leads_per_week`/`leads_per_month`, `advanced_leads_limits` (per day-of-week), `total_delivery_limit`, `pings_per_minute`, `accept_bulk_reprocess`, `accept_manually_reviewed_leads`, `accept_only_reprocessed_leads`, `accepting_leads_dates`/`accepting_leads_time`, `leads_age_filter` (min/max), `county` (state + county codes), `ip_address`, `sub_id`, `pub_id`, `optout`, `landing_page`, `custom_fields` (`io_start_date`, `currency_code`, `po_number`). | `Filter_Set_ID`; optional `Include_Additional_Deliveries` |
| `insertUpdateFilterSet` | Create/update a filter set. Parameter table not fully captured (page only showed the response shape — `status`, `filter_set_ID`) — the real field list is almost certainly the same shape as `getFilterSet`'s response fields. Re-fetch the per-lead-type detail page before building the Record Store's "buy criteria" UI. | (not fully captured — re-fetch before building) |
| `setFilterSetPriority` | Update match priority (0 = "if no other match", 1–9 low→high, 10 = high, 1000 = "Always Match"). | `Filter_Set_ID`, `Priority` |
| `setFilterSetStatus` | Enable/disable a filter set (`Status`: 0 Not Active / 1 Active). | `Partner_ID`, `Filter_Set_ID` |

### Partners (buyer accounts)
| Action | Purpose | Key params |
|---|---|---|
| `createNewPartner` | Create a new buyer account. Required: `Login` (email), `Company_Name`, `First_Name`, `Last_Name`, `Address`, `City`, `State` (US/CA), `Country`, `Zip`, `Phone`, `Lead_Email`, `Delivery_Option` (0 HTML / 1 Cell / 2 CSV email / 3 PDF email / 4 plain text). Many optional fields — see §4. | see above |
| `createNewSubPartner` | Same shape, nested under `Parent_Partner_ID`; additionally requires `Login`+`Password` up front (not optional like the top-level partner flow) and takes `Status` (0 Not Active default / 1 Temp Stopped / 2 Active). | `Parent_Partner_ID` + same core fields |
| `insertUpdatePartner` | Single action for both create and update via `Mode` (`insert`/`update`); `Partner_ID` required only for `update`. Superset of `createNewPartner`'s fields plus many more settings (dedupe, per-period limits, refund permission flags, rebill/credit-warning thresholds, `Lead_Type_Settings`/`Lead_Type_Limits` as serialized JSON arrays) — full table in §4. | `Mode` + conditional required fields |
| `updatePartnerSettings` | Update-only partner settings (only `Partner_ID` required, everything else optional patch fields) — near-identical field set to `insertUpdatePartner`'s update mode, plus a few extras (`Facebook_Url`, `Yelp_Url`, `Html_Offer`, etc.) not present there. | `Partner_ID` |
| `setPartnerStatus` | Change status (0 Not Active / 1 Temporarily Stopped / 2 Active) + `Status_Reason`. | `Partner_ID`, `Status`, `Status_Reason` |
| `getPartnerInfo` | Basic contact info for one partner (company/email/phone/website/address). | `Partner_ID` |
| `getPartnerList` | Full roster of partners (optionally filtered by comma-separated `Partner_ID` list) with rich fields: label, group, company, name, address, phone, email, `primary_lead_type`, `number_of_sub_partners`, status, `balance`, daily/monthly account limits, sales rep, credit limit, login name, comments, `date_created`. | optional `Partner_ID` (comma list) |
| `getPartnerSettings` | Deep settings dump for one partner — contact info, `default_options[]` (per-lead-type delivery preference), `filter_sets[]` (with nested `delivery_options[]`), account status, primary lead type, permission flags (`ability_to_add_funds`, `can_partner_change_status`, `can_request_lead_refunds`, `can_request_phone_delivery_refunds`), label/group, dedupe settings, sales rep + percentage, account manager, `total_leads_per_day_limit`/`total_leads_per_month_limit`. | `Partner_ID` |
| `getPartnerCreditandBalance` | `Balance`, `Credit_Limit`, `Total_Balance`, `Unlimited_Credit` (Yes/No). | `Partner_ID` |

### Payments / refunds / transactions
| Action | Purpose | Key params |
|---|---|---|
| `submitPayment` | Credit or charge a partner's account; returns new `total_balance`. `Amount` must be > 0; direction/meaning is carried by `Operation_Type` (see §4 for the code table). | `Partner_ID`, `Amount`, `Operation_Type` |
| `getTransactionDetails` | Ledger of transactions in a date range (optionally one `TYPE`): per-row `transaction_type` (e.g. "Refund", "Purchase"), `partner`, `filter`, `amount`. | `Date_Start`, `Date_End`; optional `TYPE` |
| `getRefundReasons` | System-wide list of refund reason definitions per lead type (`reason_id`, `lead_type_id`, `lead_type`, `reason`). | none beyond auth |
| `requestRefundForLead` | File a refund request for one lead. `Reason_ID` must come from `getRefundReasons`. `Refund_Type`: 1 full refund (default) / 2 phone-charges-only refund. `Automatically_Approve` can skip the approval step. | `Partner_ID`, `Lead_ID`, `Lead_Type`, `Reason_ID` |
| `getRefundRequests` | List refund requests for one partner+lead type. | `Partner_ID`, `Lead_Type` |
| `getAllRefunds` | Same idea but broader — all refund requests for a partner+lead type, with optional date range. | `Partner_ID`, `TYPE`; optional `Date_Start`/`Date_End` |
| `processRefundRequest` | Admin approves/declines a pending refund. `Process_Type`: `Approve`/`Decline`. Optional `Partial_Refund`, `Send_Notification` (emails the partner), `Comments`. | `Refund_Request_ID`, `Process_Type` |
| `undoRefundApproved` | Revert an approved refund back to pending (or set to declined) and delete its transaction. | `Lead_ID`, `TYPE`, `Partner_ID`, `Set_New_Refund_Status` (`pending`/`declined`) |
| `undoSale` | Delete the original sale transaction for a lead (no reprocessing). | `Lead_ID`, `Lead_Type`, `Partner_ID` |
| `undoSaleAndReprocess` | Same, but re-runs matching with the original partner excluded from possible matches (`result: Matched`/etc. in response). | `Lead_ID`, `Lead_Type`, `Partner_ID` |

### Lead pricing (admin overrides)
| Action | Purpose | Key params |
|---|---|---|
| `updateLeadPrice` | Set the price a specific lead sold for to a specific partner. | `TYPE`, `Lead_ID`, `Lead_Price` (> 0), `Partner_ID` |
| `updateLeadCost` | Set the system's cost basis for a lead (not tied to a partner — this is the acquisition cost, distinct from sale price). | `TYPE`, `Lead_ID`, `Lead_Cost` |

### CRM status sync (report outcome back to the exchange)
All four share the same `Lead_Status` enum:
**0 New · 1 Working Lead · 5 Closed · 6 Dead · 8 Bad Lead · 10 Did Not Qualify · 12 Quoted – Did Not Close.**
Optional `Revenue` (positive decimal) on all four.

| Action | Scope | Key params |
|---|---|---|
| `setCRMLeadStatus` | One lead, one partner (by `Partner_Login`). | `TYPE`, `Lead_ID`, `Partner_Login`, `Lead_Status` |
| `setCRMStatusByLeadID` | **Updates every status/partner tied to that `Lead_ID`** — broad, use carefully. | `TYPE`, `Lead_ID`, `Lead_Status`; optional `Partner_ID` |
| `setCRMStatusByPhone` | **Updates every lead/partner tied to that phone number** — broadest of the four. Optional date range to narrow which leads. | `TYPE`, `Primary_Phone`, `Lead_Status`; optional `Date_Start`/`Date_End`, `Partner_ID`, `Lead_ID` |
| `setCRMStatusFromGoHighLevel` | Phone-based like the above, purpose-built for GoHighLevel CRM webhooks; searches phone numbers up to 60 days back. | `TYPE`, `Primary_Phone`, `Partner_ID`, `Lead_Status` |

### Vendors / sources (upstream lead origin — not the buyer side)
| Action | Purpose | Key params |
|---|---|---|
| `getVendorsAndSources` | List vendors (with contact info) and each vendor's `sources[]` (`name`, `cost`) for one lead type. | `TYPE` |
| `createNewVendor` | Create a vendor account (`Status`: `not_approved`/`active`; `Suppression_Files`: 0 Plain/1 MD5; `Rate` 0–10). | `Status`, `Company_Name`, `First_Name`, `Last_Name`, `Address`, `City`, `State`*, `Country`, `Zip`, `Primary_Phone`, `Suppression_Files`, `Rate` |
| `updateVendor` | Patch an existing vendor by `Vendor_ID`; same optional field set as create. | `Vendor_ID` |
| `addNewSource` | Add a source under a vendor. Exact params not fully captured — inferred from error text: `TYPE`, `Source_Name`, `Vendor`, `Is_Active`, `Manual_Review_Check`, `Lead_Cost`, `Unmatched_To_Cost_Zero`, `Partners_Per_Lead`, `Delivery_Timeout`, `Ping_Delivery_Timeout`, `IP_Check`, `Source_Label`. | see above (re-verify before use) |
| `updateSRC` | Update a source's status/pricing. `Status`: active/inactive. Also: `Minimum_Profit_Margin`, `Best_Price_Offer_Limit`, `Return_Dynamic_Cost_Profit_Margin` (payday lead type only), `Lead_Cost`. Deprecated aliases noted: `src`, `leadTypeID`, `status` (lowercase — avoid). | `SRC`, `TYPE` |

### IPR — inbound phone routing (live call transfer lead types)
| Action | Purpose | Key params |
|---|---|---|
| `iprSubmitLead` | Insert/process a phone-routing lead; ping mode returns routing phone numbers with `price`/`min_duration`; post mode just confirms `status: Success`. Same error-code convention as `pingPostLead` (`Insert Error #4/#8/...`). | lead-type-specific ping/post fields |
| `iprSubmitConsent` | Same as `iprSubmitLead` but with the consent/broker-bid response shape (`bids[]`, `seller_html`, etc.), mirroring `pingPostConsent`. | lead-type-specific fields |
| `iprActivateCall` | Tell the system a call successfully connected (after the telecom provider bridges it). | `Session_ID`, `Phone` |
| `iprTerminateCall` | Tell the system a call ended — triggers per-minute billing. Optional `Recorded_File` URL. | `Session_ID`, `Phone`, `Minutes` |
| `iprCallFailed` | Tell the system the call could not connect — triggers an automatic undo-sale. | `Session_ID`, `Phone` |
| `pingRing` | "Real" ping — selects qualifying buyers now; IVR-collected values are NOT used later for matching. Returns a `terminating_phone` from a dynamic pool. | `Campaign` (confirmed required); rest undocumented |
| `noPingRing` | Lighter-weight — grabs a terminating phone from the pool WITHOUT a real ping; real matching happens once the call actually comes in, and IVR-collected values CAN be used then. | `Campaign` (confirmed required); rest undocumented |
| `iprGetFilterSets` | List IPR-specific filter sets (separate from the standard `getFilterSet`/lead filter sets) — very rich config: `assigned_clients[]`, `lead_price`, `client_ring_to`, `maximum_concurrent_calls`, `inbound_phone_routing_per_minute_fee`, `minimum_number_of_minutes_for_successful_call`, `record_phone_calls`, `default_routing_for_failed_calls`, `ring_timeout`, `accepted_sources`, `match_priority`, `daily/weekly/monthly_limit`, `day_of_week_accept_leads`, `time_of_day_accept_leads`, `accept_bulk_reprocess`, `accept_manually_reviewed_leads`, `terminating_phone` (accept-all/listed), `origin_phone_area_code_type`/`origin_phone_area_code`, `state`, `campaign`. | optional `TYPE` (defaults to 9) |
| `iprInsertFilterSet` | Create an IPR filter set — same field set as `iprGetFilterSets`' response, just as create-time inputs (`Filter_Set_Name`, `Filter_Set_Price`, `Partner_Ring_To`, `Max_Concurrent_Calls`, `Per_Minute_Fee`, `Record_Phone_Call` Yes/No, `Default_Phone_Routing` Yes/No, `Successful_Minutes`, `Ring_Timeout`, `Accepted_Sources`, `Match_Priority`, `Daily_Limit`/`Weekly_Limit`/`Monthly_Limit`, `Terminating_Phone_Type`+`Terminating_Phone`, `Origin_Phone_Area_Code_Type`+`Origin_Phone_Area_Code`, `State`, `Campaign`). | `Partner_ID` + full field set above |
| `iprUpdateFilterSet` | Patch-style update of an IPR filter set — same optional fields as insert, keyed by `Filter_Set_ID`. | `Filter_Set_ID` |

### Compliance / suppression
| Action | Purpose | Key params |
|---|---|---|
| `optOut` | Insert into or check the opt-out DB. `Optout_Action`: `insert`/`check`. `Optout_Type`: `phone`/`email`. Optional `Lead_Type`, `Note`. | `Optout_Action`, `Optout_Type`, `Value` |
| `blockListValueCheck` | Check if a phone/email is on the block list. | `Value` |
| `blockListValueInsert` | Add a phone/email to the block list. | `Value` |
| `addRemoveSuppressedNumbers` | Add/remove phone numbers from a **partner's own** suppression list (as opposed to the system-wide block list). `Action`: `add`/`remove`. Comma-separated `Phone_Numbers`. Response reports `affected_records`. | `Action`, `Partner_ID`, `TYPE`, `Phone_Numbers` |

### Misc
| Action | Purpose | Key params |
|---|---|---|
| `addLeadNote` | Attach a free-text note to a lead on behalf of a partner (by `Partner_Login`). | `TYPE`, `Lead_ID`, `Partner_Login`, `Note` |
| `cimProfileAdd` | Attach an existing Authorize.net CIM (Customer Information Manager) saved-card profile to a partner for billing. `Mode=update` replaces the existing profile. First ID in `Customer_Payment_ProfileID`'s comma list becomes the default payment method. | `Partner_ID`, `Customer_Profile_ID`, `Customer_Payment_ProfileID` |
| `addEnums` | Add new allowed values to an enum-type custom field on a lead type (e.g. adding "Maybe" to a Yes/No field). `Reorder`: 0 keep insertion order (default) / 1 alphabetical. | `TYPE`, `Field_Name`, `Enum` (comma list) |
| `removeEnums` | Remove one enum value from a field. | `TYPE`, `Field_Name`, `Enum` |
| `getIncomingAPIRequestsBySource` | Reporting: incoming ping-post API request volume by source over a date range, optionally filtered to one `SRC`. | `Date_Start`, `Date_End`, `Lead_Type`; optional `SRC` |
| `getWebCampaignsRejectURLs` | Get the configured "reject" redirect URL(s) for a web campaign/landing page. | `SRC`, `Landing_Page`; optional `LeadTypeId` |

## 4. Shared enums & reference values

**`Delivery_Option`** (partner lead-delivery preference): 0 HTML email · 1
Cell phone · 2 email with CSV attachment · 3 email with PDF attachment · 4
plain text email.

**Partner `Status`**: 0 Not Active · 1 Temporarily Stopped · 2 Active.

**Vendor `Status`**: `not_approved` · `active`.

**CRM `Lead_Status`** (used by all four `setCRM*` actions): 0 New · 1
Working Lead · 5 Closed · 6 Dead · 8 Bad Lead · 10 Did Not Qualify · 12
Quoted – Did Not Close. (Note the gaps — 2/3/4/7/9/11 are not documented on
this page; don't assume they don't exist, just that this fetch didn't
surface them.)

**Filter set `Priority`**: 0 "if no other match" · 1–9 low→high · 10 high ·
1000 "Always Match".

**`submitPayment` `Operation_Type` codes**:
2 Payment on account (credit) · 3 General service fee (charge) · 4 Other
credit (credit) · 5 Bad check received (charge) · 11 Maintenance fee
(charge) · 12 Setup fee (charge) · 27 Customer Service Related (credit) ·
28 Volume Discount (credit) · 29 Referral Discount (credit).

**`Partner_Label`**: 0 none · 1 Service Provider · 3 Reseller.

**Known `Primary_Lead_Type` IDs** (from one sampled field description, not
exhaustive/confirmed against a live lookup): 9, 19, 21, 23, 25, 27, 29, 31,
35, 37, 39 — **do not hardcode these**; call `getFilterSetsAll` or
`getPartnerSettings` against a real account to get the authoritative
current ID→name mapping before building anything that depends on a
specific `Lead_Type` integer.

**Confirmed real lead-type names seen in example data**: Mortgage, Debt
Settlement, Debt Short, Pay Day, Auto Insurance, Home Insurance, Life
Insurance, Life Calls, HVAC, HVAC Calls, Roofing, Roofing Calls, Solar,
Auto and Home Calls, Inbound Phone.

**Lead insert/process error codes** — referenced repeatedly (`Insert Error
#4: NO VALID PING MATCHES FOUND`, `Insert Error #8: Required value for
field "X" missing`) but the *full* numbered error-code table lives on a
separate "Lead Insert/Process Error Codes" documentation page that this
fetch pass did not pull — **re-fetch before writing error-handling code**
that needs to branch on specific error numbers rather than just surfacing
the message string.

## 5. Response envelope shape

Every response — success or error — is wrapped in one top-level `response`
object (both JSON and XML mirror the same structure):

```json
// Success (varies by action, but always inside response.*)
{ "response": { "...action-specific fields..." } }

// Validation/business error (both shapes seen, don't assume just one)
{ "response": { "errors": { "error": "Single message" } } }
{ "response": { "errors": { "error": ["Message 1", "Message 2"] } } }
{ "response": { "error": { "error": "Single message" } } }   // singular "error" wrapper, seen on a couple of endpoints — inconsistent, code defensively
```

Ping/post/full lead-submission actions additionally use a **`status`**
field as their real state machine, independent of HTTP status (which is
always 200 per the docs' own PHP sample expecting code 200 regardless):
`Matched` / `Unmatched` / `Success` / `Error`. Never infer success from
HTTP status alone — always read `response.status` (for ping/post actions)
or check for `response.errors`/`response.error` (for everything else).

## 6. What this means for building "Record Store"

Not yet scoped/planned — this section is deliberately left as open
questions to resolve with the user before implementation, not assumptions
baked into a plan:

- Is EvenFlow (as a whole) the single `Partner` account, with individual
  Agencies as `Sub-Partners` (`createNewSubPartner`) under one parent? Or
  does each Agency get its own top-level `Partner_ID`? This changes the
  entire integration shape (one shared API key + per-agency sub-accounts,
  vs. per-agency credentials).
- Which lead types does Yield Marketing actually want to sell through
  Record Store — all of them, or a curated subset matching EvenFlow's own
  insurance-focused product line (Auto/Home/Life/Commercial)? The
  documented lead types above include several with no obvious EvenFlow
  product match (Mortgage, Debt Settlement, Pay Day) — those are probably
  irrelevant to this integration.
  - **CONFIRMED (per the user, 2026-09-30, `Content-Type: audio` request
    logged in the Yield Marketing internal Slack channel — not yet
    corroborated against a second source, verify before load-bearing use):
    Record Store's initial launch scope is Auto Insurance, Home Insurance,
    and Life Insurance only** — matches the lead types EvenFlow's own
    `Product`/`LeadType` enums already cover. Solar/HVAC/Roofing/Mortgage/
    Debt/PayDay stay out of scope for v1.
- Does "buying a lead" mean a one-off ping/post purchase flow (browse →
  ping for price → post to buy, live in the UI), or a standing Filter
  Set an Agency Owner configures once ("buy me every Auto lead under $30
  in these ZIP codes") that then delivers automatically via this same
  API's normal delivery mechanism (`Delivery_Option`) — closer to how
  EvenFlow's own Vendor → `vendorApi.js` webhook intake already works?
  The latter is far more consistent with this app's existing architecture
  (Leads arrive via webhook, not a manual browse-and-buy UI) and would
  make Record Store essentially "configure + fund a Filter Set, then let
  `vendorApi.js`-style webhook delivery keep doing the rest" — worth
  raising as the leading option when scoping the real plan.
- Credentials: this whole API needs a real `Key` (API key) issued from
  Yield Marketing's own portal admin UI, plus (if going the sub-partner
  route) a real parent `Partner_ID`. Neither exists in any EvenFlow env
  file today — this is a hard blocker for any live integration work,
  identical in shape to the earlier `ANTHROPIC_API_KEY`/Brevo/Stripe
  credential-gating precedent already established in this codebase.
