# ADR 0027: Public GitHub projects without a connection

Creating a Project from an existing GitHub repository can use a public
`github.com` URL without a GitHub Connection. Private repositories and other
Git hosts still require the caller's GitHub App access.

Amp's New Project dialog lets a user paste a public GitHub URL when GitHub is
not connected. CoForge already stored optional GitHub IDs on Project, but
`createProject` required an installation-authorized repository. That blocked
the same create path.

The create seam now accepts `fullName` alone. `GitHubConnection.lookupPublicRepository`
confirms the name is a public github.com repository over unauthenticated REST
and stores its id/full name/html URL with a null installation ID. Selecting a
connected repository still stores the installation. Project details keep using
the viewer's personal GitHub Connection; a public mapping does not grant
in-app file or commit reads.
