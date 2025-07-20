install.sh — piped via wget.
Get PAT in github Settings -> Developer settings -> Fine granted token. Generate a token, selecting SiegeUp organisation.

```
curl -s -H "Authorization: token YOUR_PAT_TOKEN" -H "Accept: application/vnd.github.v3.raw" https://api.github.com/repos/SiegeUp/ServerLauncher/contents/install.sh?ref=main | bash
```
