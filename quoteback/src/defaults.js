// Starting follow-up sequence for a residential painter. Contractors can edit all of it.
// Kept short, personal and honest: no fake urgency or discounts.
export const DEFAULT_STEPS = [
  {
    delay_days: 2,
    subject: 'Your painting estimate from {{business_name}}',
    body: `Hi {{customer_first_name}},

I wanted to make sure the estimate for {{job_description}} came through okay. If anything in it is unclear, or you'd like to change the scope, just reply here and I'll take care of it.

Thanks,
{{owner_name}}`,
  },
  {
    delay_days: 5,
    subject: 'Any questions about your estimate?',
    body: `Hi {{customer_first_name}},

Following up on the {{job_description}} estimate. People usually have questions about colors, prep work, or timing at this point. I'm happy to answer any of those, or stop by again if it would help.

Just reply to this email or call me at {{business_phone}}.

{{owner_name}}`,
  },
  {
    delay_days: 10,
    subject: 'Scheduling your project',
    body: `Hi {{customer_first_name}},

If you're still planning the {{job_description}}, let me know roughly when you'd like it done and I'll see what we have open on the schedule.

{{owner_name}}
{{business_name}}`,
  },
  {
    delay_days: 21,
    subject: 'Should I close out your estimate?',
    body: `Hi {{customer_first_name}},

I haven't heard back, so I'll assume the timing isn't right and close out your estimate for now. No problem at all.

If you'd still like to go ahead, or want an updated quote later on, just reply to this email.

Thanks again for considering {{business_name}}.
{{owner_name}}`,
  },
];

export const MAX_STEPS = 6;
