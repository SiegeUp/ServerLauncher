install.sh — piped via wget.
To get token open install.sh in raw mode from github. Find a better solution to use PAT in future.

```
wget -qO- https://raw.githubusercontent.com/SiegeUp/ServerLauncher/refs/heads/main/install.sh?token=<TOKEN> | bash
```
