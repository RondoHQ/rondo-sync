# Sponsit: sponsoren en Laposta

De wekelijkse Sponsit-pipeline behandelt organisaties en persoonlijke sponsoren, hun personen en relaties
als afzonderlijke gegevens. De synchronisatie schrijft geen `is_sponsor`, bedrijfsnaam of
sponsorrol meer op een persoon.

## Volgorde

1. Download actieve Sponsit-contacten en hun personen. Een contact van type `company` wordt een
   organisatie; een contact van type `person` wordt een persoonlijke sponsor met één persoonsrelatie.
2. Lees zowel Rondo-personen als sponsorbedrijven.
3. Koppel personen eerst op de Sponsit-persoon-ID in bestaande sponsorrelaties, daarna op de
   tijdelijke legacy-ID en als gecontroleerde terugval op uniek e-mailadres plus naam.
4. Maak ontbrekende externe personen via de sponsorrelatie aan en werk alleen bestaande externe contacten bij. Velden
   van leden en ouders blijven eigendom van Sportlink.
5. Maak of wijzig één sponsor per `sponsit_contact_id`, inclusief de genormaliseerde website, en schrijf de contactrelaties.
6. Importeer het beveiligde Sponsit-logo alleen wanneer het bestands-ID veranderde of het Rondo-logo ontbreekt.
7. Archiveer alleen verdwenen bedrijven mét een Sponsit-ID. Handmatige Rondo-bedrijven worden
   nooit automatisch gearchiveerd.
8. Bouw de Laposta-doelgroep uit dezelfde bedrijfs- en relatiegegevens.

Een Sponsit-organisatie zonder personen blijft een geldige sponsor en veroorzaakt geen fictief
persoonrecord. Bij een onzekere match blijft de bestaande relatie ongemoeid. Een nieuwe persoon
wordt alleen via een bestaande sponsor aangemaakt, zodat Sync geen los sponsorcontact kan achterlaten.

## Dry-run en uitvoeren

`npm run preview-sponsit-rondo` toont afzonderlijke aantallen voor bedrijven, personen, relaties,
archiveringen, logo-imports en quarantaines. `npm run sync-sponsit-rondo` voert hetzelfde plan uit.

De volledige `sync-sponsit`-pipeline voert de Rondo-stap vóór Laposta uit. Daardoor kan een volgende
run altijd op de stabiele relatie-ID's aansluiten en wordt een nieuw persoon niet opnieuw gemaakt.
