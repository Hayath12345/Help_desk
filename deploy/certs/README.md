# Database CA files (RDS)

The API, worker and migrate images copy this directory to `/app/certs`. For a production build put two public files
here **before** building (they are not committed):

- `rds-global-bundle.pem` - the whole Amazon RDS CA bundle. The API and worker (node-postgres) read every certificate in
  it through `sslrootcert`.

  ```bash
  curl -fsSL -o deploy/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  ```

- `rds-ca.pem` - **one** certificate: the root that signed your instance's server certificate chain, cut out of the
  regional bundle. Prisma Migrate (the `migrate` image) trusts only the first certificate of the file named by
  `sslcert`. How to choose and cut it: `docs/DEPLOYMENT.md`, section 4.3, "Making `rds-ca.pem`".

Build with `--build-arg REQUIRE_RDS_CA=true` so the build fails if either file is missing. The database URL then points
at them:
`...?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem&sslcert=/app/certs/rds-ca.pem&sslaccept=strict`
(`sslrootcert` is read by the API and worker, `sslcert` + `sslaccept=strict` by Prisma Migrate).

Download the files from AWS when building so that they are current. Neither was tested against a real RDS instance.
