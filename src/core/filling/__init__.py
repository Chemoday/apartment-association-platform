"""Filling the building of a new installation (docs/ARCHITECTURE.md section 15, epic E13 R3).

`layout` checks rows of apartments and meters, `template` reads and writes them as CSV, `draft`
proposes them from the register or a count, and `service` writes a checked layout through the
services of `property` and `meters`. The operator commands are in `__main__`.
"""
