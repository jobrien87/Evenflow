// Sales Scripts — human producer call scripts for Internet inquiries and
// cold high-intent data, across Home/Auto/Boat/Motorcycle, plus shared
// producer guidance (before-every-call rules, objection handling,
// follow-up/quote-review language). Prepared by Melanie for a new
// salesperson to practice, then use conversationally — these are human
// producer guides, not automated outreach scripts or AI calling prompts.
//
// Static content, authored once (not database-backed, no admin editor) —
// same convention as evenflow101Content.js. Update this file directly for
// any future wording change (e.g. after a compliance/legal review of
// agency name, callback routing, producer licensing, or state/carrier
// language — see the "Review before making available" note below).
//
// Every bracketed field (e.g. [First name], [Producer], [Agency],
// [callback number], [verified source]) is left as literal fill-in-the-
// blank text, exactly as written — never dynamically interpolated. A
// producer reads the line and naturally substitutes the real value, the
// same way any printed call script works.
//
// IMPORTANT — not yet reviewed for live use: Melanie or the agency
// reviewer still needs to confirm the approved agency name, callback
// routing, producer licensing, and the states/products the agency can
// service, and to review applicable contact, recording, insurance and
// carrier language with the agency, before producers use these live.
//
// Section body shapes:
//   'prose'      — items: string[], each rendered as its own paragraph.
//   'quote'      — items: string[], literal spoken lines the producer
//                  should say near-verbatim — rendered visually distinct
//                  from prose/guidance.
//   'bullets'    — items: string[], an unordered list (e.g. discovery
//                  questions).
//   'hesitation' — items: { customerSays, response, note? }[], one block
//                  per common pushback line and how to answer it.

export const SALES_SCRIPT_GROUPS = [
  {
    id: 'internet-leads',
    title: 'Internet Leads',
    icon: 'globe',
    description: 'For a documented Internet inquiry only — match the wording to what the person actually submitted. A request for information is not automatically a request for a quote.',
    topics: [
      {
        id: 'internet-home',
        title: 'Internet Lead — Home',
        icon: 'home',
        summary: 'For a documented home insurance inquiry — match the wording to what they actually submitted.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For a documented home insurance inquiry. If the record only shows interest in a coverage review, say "coverage review," not "quote request." Check the timing preference first.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m following up on the home insurance inquiry you submitted through [verified source]. Is now a good time to talk about what you’re looking for?"',
              'If researching: "That’s fine. Are you comparing a renewal, buying a home, or just getting a feel for your options?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              '"What prompted you to take a look at your home insurance?"',
              '"Is this your primary home, a second home, or a property you rent out? What address are we reviewing?"',
              '"Who is your current insurer, and when does the policy renew or the new coverage need to start?"',
              '"What do you want to keep or improve: the premium, deductibles, coverage, or service?"',
              '"Do you have your declarations page handy? We can use it to compare limits, deductibles and any separate wind or flood coverage."',
              '"Have there been roof updates, other major updates, or recent claims we should account for?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"Based on that, I’ll check which options we can offer and compare the coverage and deductibles with what you have now. I’ll need a few more property details through our approved intake process."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"Would you also like us to review your auto insurance? I can check whether combining policies makes sense and whether any discounts apply."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"Would you like to start that now, or set a time to review it? Does [available time A] or [available time B] work? How would you like me to send the information?"',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"My mortgage company handles it."', response: '"Your mortgage company may pay the premium through escrow. We can still review the policy, but any change needs to be coordinated with the lender and the effective dates."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi [First name], this is [Producer] with [Agency], following up on your home insurance inquiry. Please call [callback number] when convenient. Again, [Producer], [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'Do not treat market value or the mortgage balance as replacement cost. Verify wind, hurricane, flood and water-related terms rather than implying they are included. If no eligible option is available, say so clearly.',
            ] },
          },
        ],
      },
      {
        id: 'internet-auto',
        title: 'Internet Lead — Auto',
        icon: 'car',
        summary: 'For a documented auto inquiry — ask which product if the form combines Auto and Motorcycle.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For a documented auto inquiry. If the form combines Auto and Motorcycle, first ask which product the person wants to discuss.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m following up on the insurance inquiry you submitted through [verified source]. Were you looking at auto insurance, motorcycle insurance, or both? Is now a good time for a few questions?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              '"What got you looking: a renewal, a different vehicle, a rate change, or something else?"',
              '"How many vehicles and drivers do we need to include?"',
              '"Where are the vehicles kept, and are they used for commuting, business, delivery or rideshare?"',
              '"Who insures you now, and when do you need coverage to start?"',
              '"What matters most in the comparison? Are there limits or deductibles you want to keep?"',
              '"Do you have your current declarations page? We can compare the actual coverages rather than just the monthly payment."',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"Let’s build the comparison around how you use the vehicles and the protection you want. I’ll confirm the vehicle and driver details through our quote process before presenting a price."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"Do you own or rent your home? If you’d like, I can check a home or renters option alongside the auto quote and see whether a discount is available."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"We can start now, or book a time to go over it together. Which works better? Before we finish, let’s confirm [date, time, time zone], the number to use, and what you’ll need to have ready."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"I only care about the cheapest price."', response: '"Price matters. Let’s compare the limits and deductibles too, so you know what you would be buying. What premium are you trying to get close to?"' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi [First name], this is [Producer] with [Agency], following up on your auto insurance inquiry. You can reach me at [callback number]. Again, [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'Use "auto" in the voicemail only if that product is verified. Do not describe liability-only coverage as full coverage or remove protection just to show a lower price.',
            ] },
          },
        ],
      },
      {
        id: 'internet-boat',
        title: 'Internet Lead — Boat',
        icon: 'tag',
        summary: 'For a documented boat insurance inquiry — confirm whether they already own the boat.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For a documented boat insurance inquiry. Confirm whether the person already owns a boat or is considering one.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m following up on the boat insurance inquiry you submitted through [verified source]. Are you looking at coverage for a boat you own, or one you’re planning to buy?"',
              '"Is now a good time to go through a few details?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              '"What year, make and model is the boat, and about how long is it?"',
              '"Where do you keep it, and where do you normally use it?"',
              '"Is it for personal recreation, or is there any rental, charter or other business use?"',
              '"Who operates it, and what boating experience or safety training do they have?"',
              '"Is it insured now? When does that policy renew, and is there a lender?"',
              '"What do you want us to focus on: the boat’s value, liability, deductibles, towing, equipment, or another concern?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"I’ll use those details to check eligibility and compare how the policy handles a covered loss, the boating area and the deductible. If you have a current policy, we can review it alongside the options."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"Would you like us to look at your auto or home coverage too? I’ll check any available discounts without assuming that one package is the best fit."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"When are you hoping to have coverage in place? Let’s set [available appointment] to review the options, or we can begin the intake now if you have time."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"The boat is covered by my homeowners policy."', response: '"Some home policies provide limited watercraft coverage. Let’s check your policy’s limits and restrictions before assuming it covers this boat and how you use it."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi [First name], this is [Producer] with [Agency], following up on your boat insurance inquiry. Please call [callback number]. Again, [Producer] at [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'Check valuation and settlement terms, navigation limits, wind or storm provisions, storage and lay-up conditions. Do not promise agreed value, offshore use, salvage, pollution or towing coverage unless confirmed in the offered policy.',
            ] },
          },
        ],
      },
      {
        id: 'internet-motorcycle',
        title: 'Internet Lead — Motorcycle',
        icon: 'tag',
        summary: 'For a documented motorcycle inquiry — clarify the product before quoting.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For a documented motorcycle inquiry. For an Auto and Motorcycle form response, clarify the product before quoting.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m following up on the insurance inquiry you submitted through [verified source]. Were you looking at motorcycle coverage, auto coverage, or both?"',
              '"Is now a good time to talk about the bike and what you need?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              '"What year, make and model is the motorcycle?"',
              '"How do you use it: occasional rides, commuting, or something else?"',
              '"Who rides it, and what riding experience and safety training do they have?"',
              '"Where is it kept? Are there custom parts, accessories or riding gear you want us to consider?"',
              '"Who insures it now, when does that policy renew, and is there a loan on the bike?"',
              '"What matters most to you: price, liability protection, damage to the bike, passenger-related coverage, or another concern?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"I’ll compare options for how you ride and what you want protected. We’ll review the limits, deductibles and any accessory or gear limits rather than assuming they are all included."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"Would you like an auto or home review as well? I can check whether any multi-policy or rider-related discounts apply."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"Would you like to begin the quote details now or schedule a review? Let’s confirm [date, time, time zone], your preferred permitted contact method, and the details you’ll have ready."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"I barely ride it."', response: '"Then let’s tell the insurer how you actually use and store it. We can check available options, including what protection remains while it is stored. I wouldn’t assume a seasonal change is right until we review the terms."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi [First name], this is [Producer] with [Agency], following up on your motorcycle insurance inquiry. Please call [callback number]. Again, [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'Do not assume an auto policy covers the motorcycle. Verify passenger-related protection, uninsured or underinsured motorist options, accessories and storage terms for the customer’s state and policy.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'cold-high-intent-data',
    title: 'Cold High Intent Data',
    icon: 'phone',
    description: 'For cleared cold prospect data only — the person has not requested a quote from your agency. A data signal is neither consent nor proof of ownership. Manual dialing only.',
    topics: [
      {
        id: 'cold-home',
        title: 'Cold High Intent Data — Home',
        icon: 'home',
        summary: 'For cleared cold prospect data only — never say the person requested a quote. Manual dialing only.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For cleared cold prospect data only. Do not say "you requested a quote," refer to browsing activity, or assume the person owns a home. Manual dialing only.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m calling to offer a home insurance review. I know you weren’t expecting my call. Would you be open to a quick conversation to see whether a review would be useful?"',
              'If no: "No problem. Thank you for your time." End the call; do not launch into the pitch.',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              'If yes: "Are you responsible for choosing insurance for a home, or is that not relevant for you?"',
              '"When did you last review your policy, and when is the next renewal?"',
              '"Is there anything you would want to improve about the cost, deductible, coverage or service?"',
              '"Who is the current insurer? Is the property your primary home, a second home, or a rental?"',
              '"If we compare options, would you have a current declarations page available?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"A useful comparison starts with what you already have. With your permission, I can collect the property details and see whether we have an eligible option worth reviewing. I can’t tell you yet whether it will cost less."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"If a review makes sense, would you also want us to check auto coverage? We can look at any available multi-policy options."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"Would you prefer to begin now or choose a time closer to your renewal? May I call you at [specific agreed time]? I’ll note that preference."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"How did you get my number?"', response: '"Our agency received your contact information through [verified data provider/source] for insurance outreach. That does not mean you asked us for a quote. If you don’t want further calls, I’ll put you on our do-not-call list."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi, this is [Producer] with [Agency]. I’m calling to offer a home insurance review. If that would be useful, you can reach me at [callback number]. Again, [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'If the source is not verified, say you need to check it; never invent an explanation. Do not ask for property details unless the person agrees to continue. An opt-out ends the sales conversation immediately.',
            ] },
          },
        ],
      },
      {
        id: 'cold-auto',
        title: 'Cold High Intent Data — Auto',
        icon: 'car',
        summary: 'For cleared cold prospect data only — the lead label alone is not consent. Manual dialing only.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For cleared cold prospect data only. The lead label does not establish a quote request, current shopping or contact consent. Manual dialing only.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m calling to offer an auto insurance comparison. I know this is an unexpected call. Would a quick review be useful, or is this not something you want to discuss?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              'If interested: "When does your current policy renew?"',
              '"What would make a comparison worthwhile for you: price, coverage, service, or a recent change?"',
              '"How many vehicles and drivers would you want included?"',
              '"Who is your current insurer? Are the vehicles used only personally, or for business, delivery or rideshare too?"',
              '"Do you have your current limits and deductibles handy, or could you have the declarations page ready for a review?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"If you’re open to it, we can compare an eligible option against your current coverage. I’ll need to verify the vehicle and driver details before giving you a price, and I’ll point out any differences."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"Would you want a home or renters comparison alongside it? We can check whether a discount is available and whether the combined cost makes sense."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"Would you like to start now, or would [available time] be better? Is this the number you want us to use for that agreed follow-up?"',
              'If not interested: "No problem. Thank you for your time."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"I already have insurance."', response: '"That makes sense. The offer is a comparison with your existing policy, if you want one. If you’re happy with what you have and don’t want a review, I’ll leave it there."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi, this is [Producer] with [Agency]. I’m calling to offer an auto insurance comparison. If you would like to review your options, call [callback number]. Again, [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'Do not claim a special rate is waiting, a policy is expiring, or the prospect qualifies for savings unless verified. If asked not to call, record and honor the opt-out across the agency’s calling workflow.',
            ] },
          },
        ],
      },
      {
        id: 'cold-boat',
        title: 'Cold High Intent Data — Boat',
        icon: 'tag',
        summary: 'For cleared cold prospect data only — don’t assume boat ownership from a label. Manual dialing only.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For cleared cold prospect data only. Do not assume the person owns a boat because a data file labels them Boat. Manual dialing only.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m reaching out to offer a boat insurance review. This is an unexpected sales call, so I’ll be brief. Is boat insurance relevant for you, and are you open to discussing it?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              'If yes: "Is this for a boat you own now or one you’re considering buying?"',
              '"What kind of boat is it, and where do you keep and use it?"',
              '"Is the use strictly personal, or is there any charter, rental or other business use?"',
              '"Do you have a separate boat policy now, and when does it renew?"',
              '"What would make a review worthwhile: the premium, how a loss is valued, liability protection, towing or equipment?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"If you would like a comparison, I’ll check the boat details and how you use it, then review any available option against your current policy. The boating area and coverage terms matter just as much as the price."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"If it helps, we can also review your auto or home coverage. Any package or discount would need to be checked for eligibility."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"Would you like to begin that review now, or set [available time]? If you’re buying, when would you need coverage to take effect?"',
              'If boat insurance is irrelevant: "Thanks for letting me know. I’ll correct that in our records."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"I only use the boat a few months a year."', response: '"Then we should look at how it is stored and used during the rest of the year. I can check the policy’s storage or lay-up terms, rather than assume coverage should stop."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi, this is [Producer] with [Agency]. I’m calling about a boat insurance review. If that is relevant and you would like to talk, my number is [callback number]. Again, [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'If the person does not own or plan to buy a boat, do not keep pitching the boat script. Do not imply business use, storms, towing or offshore navigation are automatically covered.',
            ] },
          },
        ],
      },
      {
        id: 'cold-motorcycle',
        title: 'Cold High Intent Data — Motorcycle',
        icon: 'tag',
        summary: 'For cleared cold prospect data only — don’t assume ownership or recent shopping. Manual dialing only.',
        sections: [
          {
            heading: 'WHEN TO USE THIS SCRIPT',
            body: { type: 'prose', items: [
              'For cleared cold prospect data only. Do not assume motorcycle ownership or recent shopping. Manual dialing only.',
            ] },
          },
          {
            heading: 'OPENING',
            body: { type: 'quote', items: [
              '"Hi, is this [First name]? This is [Producer] with [Agency]. I’m calling to offer a motorcycle insurance review. I know you weren’t expecting the call. Is motorcycle insurance something you handle, and would a brief comparison be useful?"',
            ] },
          },
          {
            heading: 'DISCOVERY',
            body: { type: 'bullets', items: [
              'If yes: "What kind of bike do you ride, or are you looking at buying one?"',
              '"How do you use it: occasional rides, commuting, or something else?"',
              '"Who rides it, and where is it kept?"',
              '"Do you have coverage now, and when does that policy renew?"',
              '"What would you want to improve or protect: the premium, liability limits, the bike itself, accessories or riding gear?"',
            ] },
          },
          {
            heading: 'MOVE TO THE QUOTE',
            body: { type: 'quote', items: [
              '"With your permission, I can gather the details and see what options are available for your bike and riding habits. We’ll compare the limits and deductibles and check anything that needs separate coverage."',
            ] },
          },
          {
            heading: 'OFFER A RELATED REVIEW',
            body: { type: 'quote', items: [
              '"Would you like to review auto or home insurance at the same time? I can check any available multi-policy options, but we’ll compare the total cost before deciding."',
            ] },
          },
          {
            heading: 'CLOSE WITH A NEXT STEP',
            body: { type: 'quote', items: [
              '"Would now work for the quote details, or should we schedule [available time]? I’ll confirm what information to have ready."',
              'If irrelevant or declined: "No problem. Thanks for your time."',
            ] },
          },
          {
            heading: 'COMMON HESITATION',
            body: { type: 'hesitation', items: [
              { customerSays: '"I have a great rate already."', response: '"Then it may be worth keeping. If you want a comparison, we can check the protection as well as the price. If you don’t want a review, I won’t take more of your time."' },
            ] },
          },
          {
            heading: 'VOICEMAIL',
            body: { type: 'quote', items: [
              '"Hi, this is [Producer] with [Agency]. I’m calling to offer a motorcycle insurance review. If that would be helpful, please call [callback number]. Again, [callback number]."',
            ] },
          },
          {
            heading: 'PRODUCER NOTE',
            body: { type: 'prose', items: [
              'Never promise a safety-course discount, accessory coverage or seasonal savings before checking eligibility and policy terms. Do not use AI or prerecorded voicemail with these manual-only records.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'shared-producer-guidance',
    title: 'Shared Producer Guidance',
    icon: 'checklist',
    description: 'Rules, objection handling, and follow-up language that apply across every script above — read these before working either lead type.',
    topics: [
      {
        id: 'before-every-call',
        title: 'Before Every Call',
        icon: 'checklist',
        summary: 'Source selection, DNC/suppression checks, manual-dialing-only rules, licensing, and secure intake.',
        sections: [
          {
            heading: 'CHOOSE THE RIGHT OPENING',
            body: { type: 'bullets', items: [
              'Internet inquiry: use only when the record documents an actual inquiry and the agency is permitted to contact the person. Match the wording to what they submitted. A request for information is not automatically a request for a quote.',
              'Cold high-intent data: the person has not requested a quote from your agency. A data signal is neither consent nor proof that the person owns the property or vehicle. Start with a clear introduction and a permission-based offer.',
              'If the form says "No" to reviewing coverage, the record is suppressed, or permissions are unclear, stop and resolve that before outreach. Do not use an Internet opening to warm up a cold record.',
            ] },
          },
          {
            heading: 'BEFORE EVERY CALL',
            body: { type: 'bullets', items: [
              'Use the agency’s approved name, your real name and an approved callback number. Replace every bracketed field. Melanie’s office number in current correspondence is 386-427-0500; confirm the intended callback routing before use.',
              'Check the latest applicable DNC and agency suppression records, lead-source restrictions, scrub validity, permitted local calling hours and frequency limits. A prior scrub or a "high-intent" label does not establish permission by itself.',
              'The supplied high-intent lists are manual dialing only. Do not load them into predictive or automated calling, AI voice, prerecorded or ringless-voicemail campaigns, or text sequences based on the scrub. Manual dialing does not remove other requirements.',
              'Confirm the producer’s license and permitted duties for the customer’s state. A new hire who is not properly licensed must use an agency-approved intake path and hand coverage advice, recommendations, quotes and binding to an authorized licensed producer.',
              'If calls are recorded, follow the agency’s approved disclosure and consent process. Use approved secure intake for driver’s license numbers, dates of birth, payment details and documents. Do not request these in ordinary texts or voicemail.',
            ] },
          },
          {
            heading: 'HOW TO USE THE SCRIPTS',
            body: { type: 'prose', items: [
              'Read the spoken lines, not the headings or producer notes. Ask one question at a time, listen, and confirm the answer. Aim for a useful coverage conversation and one agreed next step. Never promise savings, approval, carrier availability or immediate coverage. Rates and coverage depend on eligibility, underwriting and policy terms. The agency should review applicable requirements and carrier language before use; this packet is not a legal approval.',
            ] },
          },
        ],
      },
      {
        id: 'common-objections',
        title: 'Responses to Common Objections',
        icon: 'help',
        summary: 'Opt-outs, source questions, timing, price pushback, and mistaken-record responses.',
        sections: [
          {
            heading: 'I NEVER ASKED FOR A QUOTE — INTERNET LEAD',
            body: { type: 'hesitation', items: [
              { customerSays: '"I never asked for a quote"', response: '"Thanks for telling me. I may have an incorrect or misunderstood record. I won’t assume you requested a quote. Would you like us not to contact you again?"', note: 'Do not argue with the person or repeat the claimed inquiry as proof.' },
            ] },
          },
          {
            heading: 'I NEVER ASKED FOR A QUOTE — COLD DATA',
            body: { type: 'hesitation', items: [
              { customerSays: '"I never asked for a quote"', response: '"That’s correct. This is an outreach call to offer a review, not a follow-up to a quote request. If you don’t want to discuss it, I’ll leave it there."' },
            ] },
          },
          {
            heading: 'STOP CALLING OR REMOVE ME',
            body: { type: 'hesitation', items: [
              { customerSays: '"Stop calling" / "Remove me"', response: '"Of course. I’ll put this number on our do-not-call list. Goodbye."', note: 'End the pitch immediately. Record and action the request through the agency’s suppression process; stop scheduled follow-ups and covered channels as applicable. Do not require the person to provide extra information or hear another offer.' },
            ] },
          },
          {
            heading: 'I AM BUSY',
            body: { type: 'hesitation', items: [
              { customerSays: '"I am busy"', response: '"Would you like a call at another time, or would you prefer no follow-up?"', note: 'If they choose a time, confirm the date, local time and number. Do not assume "busy" authorizes a recurring sequence.' },
            ] },
          },
          {
            heading: 'JUST SEND ME SOMETHING',
            body: { type: 'hesitation', items: [
              { customerSays: '"Just send me something"', response: '"What would be useful: an explanation of the coverage we can review, or the details needed for a quote? Is [approved email or other permitted channel] the best way to send that?"', note: 'Confirm the address and permission for that specific message. Do not treat a requested email as permission for texts, automated calls or an ongoing campaign.' },
            ] },
          },
          {
            heading: 'I LIKE MY AGENT',
            body: { type: 'hesitation', items: [
              { customerSays: '"I like my agent"', response: '"That’s a good reason to stay. If you want a second look at the coverage or price, I can help. If you’re not looking, I understand."' },
            ] },
          },
          {
            heading: 'CAN YOU GUARANTEE A LOWER PRICE',
            body: { type: 'hesitation', items: [
              { customerSays: '"Can you guarantee a lower price?"', response: '"No. I need to verify the details and available options first. I can give you a clear comparison and explain where the coverage or deductible is different."' },
            ] },
          },
          {
            heading: 'THE QUOTE IS TOO HIGH',
            body: { type: 'hesitation', items: [
              { customerSays: '"The quote is too high"', response: '"Let’s see what is driving it. Are we comparing the same term, limits, deductibles and payment plan? I can review legitimate discounts or options, explain the trade-offs, and see whether any available option fits better."' },
            ] },
          },
          {
            heading: 'I NEED TO THINK ABOUT IT',
            body: { type: 'hesitation', items: [
              { customerSays: '"I need to think about it"', response: '"What would you like to feel clearer about: the price, the coverage, or making the change? We can review that now, or agree on a follow-up if you want one."' },
            ] },
          },
          {
            heading: 'I DO NOT GIVE INFORMATION OVER THE PHONE',
            body: { type: 'hesitation', items: [
              { customerSays: '"I do not give information over the phone"', response: '"That’s reasonable. You can call the agency using the number on our official listing, or we can use our approved secure intake process. You don’t need to give me sensitive information on this call."' },
            ] },
          },
          {
            heading: 'WRONG NUMBER',
            body: { type: 'hesitation', items: [
              { customerSays: '"Wrong number"', response: '"Thank you for letting me know. I’ll correct the record."', note: 'End the call and mark it invalid.' },
            ] },
          },
          {
            heading: 'ALREADY A CUSTOMER',
            body: { type: 'hesitation', items: [
              { customerSays: '"I’m already a customer"', response: '"Thanks for telling me. I’ll check the record before treating this as new business."', note: 'Follow the agency’s customer-service and carrier rules; do not work an excluded customer as a fresh prospect.' },
            ] },
          },
        ],
      },
      {
        id: 'follow-up-quote-review',
        title: 'Follow-Up and Quote Review',
        icon: 'refresh',
        summary: 'Customer priorities, a clear quote presentation, binding limits, and next-step logging.',
        sections: [
          {
            heading: 'A SIMPLE FOLLOW-UP CALL',
            body: { type: 'prose', items: [
              'Use only after an actual conversation and within the agreed contact permission.',
            ] },
          },
          {
            heading: 'FOLLOW-UP OPENING',
            body: { type: 'quote', items: [
              '"Hi [First name], it’s [Producer] with [Agency]. We spoke on [date] about [product], and you asked me to follow up [today/at this time]. You wanted to look at [stated priority]. Is now still a good time?"',
            ] },
          },
          {
            heading: 'IF THERE WAS NO PRIOR CONVERSATION',
            body: { type: 'prose', items: [
              'If no prior conversation occurred, do not use "we spoke" or imply an appointment. Use the correct original Internet or cold opening.',
            ] },
          },
          {
            heading: 'A CLEAR QUOTE PRESENTATION',
            body: { type: 'quote', items: [
              '"You told me [priority] mattered most. This option is [premium] for [policy term], with [payment plan and any applicable fees]. Here are the main limits and deductibles, what differs from your current policy, and anything important that is excluded or optional. The proposed effective date is [date], subject to the required approvals and completed binding steps. What would you like me to explain first?"',
            ] },
          },
          {
            heading: 'ASK FOR THE DECISION',
            body: { type: 'quote', items: [
              '"Based on that comparison, would you like to move forward, make an adjustment, or take more time?"',
              'If ready: "Let’s confirm the application details and complete the required approval, signature and payment steps through our approved process. I’ll confirm the coverage and effective date when binding is complete."',
            ] },
          },
          {
            heading: 'BEFORE CONFIRMING COVERAGE',
            body: { type: 'prose', items: [
              'Do not tell the customer they are covered until an authorized confirmation exists. Do not advise cancelling the old policy before the new coverage and dates are confirmed.',
            ] },
          },
          {
            heading: 'WHEN AN OPTION IS NOT AVAILABLE',
            body: { type: 'quote', items: [
              '"Based on the details we’ve reviewed, I don’t have an eligible option to offer through our agency right now. I don’t want to give you a misleading quote."',
            ] },
          },
          {
            heading: 'REFERRALS',
            body: { type: 'prose', items: [
              'Only discuss a referral or later review if the agency permits it and the person wants it.',
            ] },
          },
          {
            heading: 'WHEN A LICENSED PRODUCER IS NEEDED',
            body: { type: 'quote', items: [
              '"I’ll bring in [Licensed producer], who can review the coverage and quote with you. Is it okay if I connect you now?"',
            ] },
          },
          {
            heading: 'HANDOFF LANGUAGE',
            body: { type: 'quote', items: [
              '"[Customer first name] wants to review [product] because [priority]. We confirmed [two or three relevant facts]. They’d like help with [next question]."',
            ] },
          },
          {
            heading: 'HANDOFF GUIDANCE',
            body: { type: 'prose', items: [
              'Share only what is needed, then let the licensed producer take over.',
            ] },
          },
          {
            heading: 'A FOLLOW-UP PLAN WITHOUT OVERCONTACTING',
            body: { type: 'prose', items: [
              'Work permitted new inquiries promptly and respect the timing preference on the form. After a conversation, use the next step the customer agreed to. For unresponsive leads, use only an agency-approved cadence that satisfies applicable hours, frequency limits and source restrictions.',
              'Yield’s existing delivery guidance mentions up to seven contacts where appropriate and permitted. That is not a requirement, seven calls, or permission to use every channel. Stop for opt-outs, invalid numbers, revoked permission or any applicable suppression. A fresh scrub is needed when the prior one expires.',
            ] },
          },
          {
            heading: 'LOG THE OUTCOME',
            body: { type: 'prose', items: [
              'Record Internet inquiry or cold data; product; verified source and inquiry date if any; permission basis and scrub status; call outcome; requested contact preferences or opt-out; priority; renewal or target date; facts still needed; assigned licensed producer; and the exact next step, date, time and time zone. Do not put sensitive identifiers or payment data in free-text notes.',
            ] },
          },
        ],
      },
    ],
  },
];
