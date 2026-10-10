{
  description = "Development shell";

  inputs.nix-devenv.url = "github:dryvist/nix-devenv?ref=v0";

  outputs =
    { nix-devenv, ... }:
    {
      devShells = builtins.mapAttrs (_: shells: {
        default = shells.typescript;
      }) nix-devenv.devShells;
    };
}
