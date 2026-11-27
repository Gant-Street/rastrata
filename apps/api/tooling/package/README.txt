Rastrata

Accounting that runs on your own computer. This folder is the whole package: nothing here needs
a network, a database, or any other software.

  ./install.sh              installs it for you and starts it; it prints the address to open
  ./install.sh --port N     use another port (the default is 7278)

Then open http://127.0.0.1:7278 in your browser, or run: rastrata open

After installing:

  rastrata status           is it running, and where your books are
  rastrata doctor           checks the install, the owner lock and your backups
  rastrata logs             what it has been doing
  rastrata stop / start     it also starts by itself when you log in
  rastrata update --from rastrata-VERSION-OS-ARCH.tar.gz    install a newer package
  rastrata uninstall        remove the programs and the login item; your books are kept

Your books and backups are in your data directory (rastrata status shows where). Copy the backups
to another drive too: a backup on the same disk does not survive that disk failing.

bin/                     rastrata (the command line tool) and rastrata-service (the service)
share/rastrata/          the login item templates, for anyone who wants to read them first
SHA256SUMS               the checksum of every file; install.sh checks them before it installs
