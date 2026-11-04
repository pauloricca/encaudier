"""Small terminal progress display; redirected output uses ordinary lines."""

import sys


class Progress:
    def __init__(self, label):
        self.label = label
        self.percent = -1

    def __enter__(self):
        self(0)
        return self

    def __call__(self, percent):
        self.show(min(99, int(percent)))

    def restart(self):
        self.percent = -1
        self(0)

    def show(self, percent):
        if percent <= self.percent:
            return
        self.percent = percent
        terminal = sys.stderr.isatty()
        prefix = "\r" if terminal else ""
        print(f"{prefix}{self.label}: {percent:3d}%",
              end="" if terminal else "\n", file=sys.stderr, flush=True)

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.show(100)
        if sys.stderr.isatty():
            print(file=sys.stderr, flush=True)
