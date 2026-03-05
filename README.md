# HubSpot Entity Creator

Self-service tool for creating test partner/customer entities in HubSpot.

## What it does

1. Creates a **partner** company (`companytype=partner`) + primary contact
2. Creates a **customer** company (`companytype=customer`) + primary contact
3. Associates contacts to their respective companies
4. Creates a **labeled association** between the partner and customer companies

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_ORG/hubspot-self-service)

Or manually:

```bash
npm install
npm run dev        # local dev at http://localhost:3000
```

Push to a Git repo and connect it to Vercel — zero config needed.

## HubSpot setup

You need a **Private App** in HubSpot with these scopes:

- `crm.objects.companies.read`
- `crm.objects.companies.write`
- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.schemas.companies.read`

To create one: HubSpot → Settings → Integrations → Private Apps → Create.

The token is entered per-session in the form and **never stored** server-side.

## Architecture

```
Browser (form)
  │
  ├─ POST /api/labels   → fetches company↔company association labels
  │                        + portal ID (for record URLs)
  │
  └─ POST /api/create   → sequential HubSpot API calls:
                           1. Create partner company
                           2. Create partner contact (associated)
                           3. Create customer company
                           4. Create customer contact (associated)
                           5. Associate partner↔customer companies
```

No database, no env vars, no server-side state. The user's HubSpot token
travels only in the request body to the API routes, which proxy to HubSpot.
