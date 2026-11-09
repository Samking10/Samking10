import { html } from './html.js';

export function page({ title, body, req, nav = true, narrow = false, header = true }) {
  const user = req?.user;
  const path = req?.path || '';
  const link = (href, label) => html`<a href="${href}" class="${path === href || (href !== '/app' && path.startsWith(href)) ? 'on' : ''}">${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${!header ? title : title ? `${title} · QuoteBack` : 'QuoteBack'}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><rect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%231f6feb%22/><path d=%22M9 17l5 5 9-11%22 stroke=%22white%22 stroke-width=%223.5%22 fill=%22none%22 stroke-linecap=%22round%22/></svg>">
</head>
<body>
${header ? html`<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="${user ? '/app' : '/'}">QuoteBack</a>
    ${nav && user ? html`<nav>
      ${link('/app', 'Home')}
      ${link('/app/estimates', 'Estimates')}
      ${link('/app/sequence', 'Follow-ups')}
      ${link('/app/report', 'Results')}
      ${link('/app/settings', 'Settings')}
      ${user.isAdmin ? link('/admin', 'Admin') : ''}
    </nav>
    <form method="post" action="/logout" class="logout"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="linklike">Log out</button></form>`
    : nav ? html`<nav><a href="/login">Log in</a><a class="btn small" href="/signup">Get started</a></nav>` : ''}
  </div>
</header>` : ''}
<main class="wrap ${narrow ? 'narrow' : ''}">
${body}
</main>
<script src="/static/app.js" defer></script>
</body>
</html>`.toString();
}
