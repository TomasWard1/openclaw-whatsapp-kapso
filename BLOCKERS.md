# Known blockers

## 1. First npm publish requires OIDC trusted publisher setup

The `.github/workflows/publish.yml` workflow uses npm's OIDC trusted publishing
(no `NPM_TOKEN` secret needed). **This requires a one-time manual configuration
on npmjs.com before the first tag push succeeds.**

Steps:

1. Create the package on npm (one-time) by doing a local `npm publish` with an
   authenticated session — OR wait for CI's first attempt to fail with a
   package-not-found error, then configure trust below.
2. Go to <https://www.npmjs.com/package/openclaw-whatsapp-kapso/access>.
3. Under **Trusted Publishers**, click **Add trusted publisher** → GitHub
   Actions.
4. Fill in:
   - Organization or user: `TomasWard1`
   - Repository: `openclaw-whatsapp-kapso`
   - Workflow filename: `publish.yml`
   - Environment: `npm-publish`
5. Save.
6. Re-run the failed `Publish` workflow from the Actions tab, or push a new tag.

After that, every tag push `v*` publishes automatically with provenance.

## 2. First publish can also be done locally

If you want to ship the first version without configuring OIDC:

```bash
npm login
npm whoami      # verify
npm publish --access public --provenance
```

Then configure OIDC (step 1 above) so subsequent releases go through CI.
