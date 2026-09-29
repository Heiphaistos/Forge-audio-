#!/usr/bin/env node
// Manage Forge Audio accounts:
//   npm run accounts -- list
//   npm run accounts -- add <utilisateur> [Nom affiché]   (génère un mot de passe de 80 caractères)
//   npm run accounts -- passwd <utilisateur>               (nouveau mot de passe généré)
//   npm run accounts -- remove <utilisateur>
// In Docker: docker exec -it forge-audio node server/src/accounts-cli.js add evan Evan
import { Accounts, Sessions, generatePassword } from './accounts.js';
import { resolvePaths } from './paths.js';
import path from 'node:path';

const [cmd, user, ...rest] = process.argv.slice(2);
const { dataDir, accountsFile } = resolvePaths();
const accounts = new Accounts(accountsFile);

async function main() {
  switch (cmd) {
    case 'list': {
      const list = accounts.list();
      if (!list.length) console.log('Aucun compte : le serveur fonctionne sans connexion (mode local).');
      for (const u of list) console.log(`${u.username}\t${u.displayName}`);
      break;
    }
    case 'add':
    case 'passwd': {
      if (!user) throw new Error('Précisez le nom d\'utilisateur');
      if (cmd === 'passwd' && !accounts.get(user)) throw new Error(`Compte inconnu : ${user}`);
      if (cmd === 'add' && accounts.get(user)) throw new Error(`Le compte ${user} existe déjà (utilisez passwd)`);
      const password = generatePassword(80);
      await accounts.set(user, rest.join(' ') || undefined, password);
      new Sessions(path.join(dataDir, 'sessions.json')).destroyUser(user.toLowerCase());
      console.log(`Compte ${user.toLowerCase()} ${cmd === 'add' ? 'créé' : 'mis à jour'}. Mot de passe (à conserver, il n'est stocké que haché) :\n\n${password}\n`);
      break;
    }
    case 'remove': {
      if (!accounts.remove(user || '')) throw new Error(`Compte inconnu : ${user}`);
      new Sessions(path.join(dataDir, 'sessions.json')).destroyUser(user.toLowerCase());
      console.log(`Compte ${user} supprimé (sa bibliothèque reste dans ${dataDir}/users).`);
      break;
    }
    default:
      console.log('Usage : accounts-cli.js list | add <utilisateur> [Nom] | passwd <utilisateur> | remove <utilisateur>');
  }
  // Let the debounced session write finish.
  await new Promise((r) => setTimeout(r, 400));
}

main().catch((err) => {
  console.error(`Erreur : ${err.message}`);
  process.exit(1);
});
