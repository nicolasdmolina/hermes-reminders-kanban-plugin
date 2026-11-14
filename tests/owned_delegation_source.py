"""Limit the live proof's source access to its recorded fixture."""


class OwnedSource:
    def __init__(self, call, identity):
        self.call = call
        self.identity = identity

    def __call__(self, op, **fields):
        if op in {"read_many", "completion-read"}:
            return [row for row in self.call(op, **fields) if row["id"] == self.identity]
        if op != "lists":
            if op not in {"read", "complete-occurrence", "delegation-link"}:
                raise ValueError("Unsupported proof operation")
            identities = [fields[key]["id"] if key == "expected" else fields[key]
                          for key in ("id", "expected") if key in fields]
            if not identities or any(identity != self.identity for identity in identities):
                raise ValueError("Source is not this proof's recorded fixture")
        return self.call(op, **fields)

    def link(self, expected, target):
        return self(
            "delegation-link", id=expected["id"], expected=expected, notes=target,
            url=target.rsplit("\n\nOpen in Hermes: ", 1)[1],
        )
