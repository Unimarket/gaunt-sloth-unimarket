# v2.1.4

- `gth eval` reads `reporters` from the config the run was started with (the `-i` profile, the `-c` file or the project config), including for suites with an `identities:` matrix. A reporter registered only in an identity's profile is no longer used.
- A reporter package that can't be found from the `.gsloth` folder is looked up from the folder `gth` was started in, so an eval project in a subfolder can use the reporters it installed.
- `gth eval` loads only the reporters named in `--reporter`, so a registered reporter that isn't installed no longer fails a run with exit 2.
