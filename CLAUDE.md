# SWFT CRM — Claude Instructions

## Deployment

**Always manually trigger a Render deploy after every push. Never assume auto-deploy.**

Deploy hook:
```
curl -X POST "https://api.render.com/deploy/srv-d750rhq4d50c73e2ktr0?key=5gwEJNyKzDI"
```

Run this after every `git push`. Confirm HTTP 201 response = deploy triggered.

## Branch
All changes go to `main` branch.
