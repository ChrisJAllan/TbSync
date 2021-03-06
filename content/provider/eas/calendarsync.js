"use strict";

eas.sync.Calendar = {

    // --------------------------------------------------------------------------- //
    // Read WBXML and set Thunderbird item
    // --------------------------------------------------------------------------- //
    setThunderbirdItemFromWbxml: function (item, data, id, syncdata) {
        
        let asversion = tbSync.db.getAccountSetting(syncdata.account, "asversion");
        item.id = id;
        let easTZ = new eas.TimeZoneDataStructure();

        eas.sync.setItemSubject(item, syncdata, data);
        eas.sync.setItemLocation(item, syncdata, data);
        eas.sync.setItemCategories(item, syncdata, data);
        eas.sync.setItemBody(item, syncdata, data);

        //timezone
        let utcOffset =eas.defaultUtcOffset;
        if (data.TimeZone) {
            //load timezone struct into EAS TimeZone object
            easTZ.base64 = data.TimeZone;
            utcOffset = easTZ.utcOffset;
            tbSync.dump("Recieve TZ","Extracted UTC Offset: " + utcOffset + ", Guessed TimeZone: " + eas.offsets[utcOffset] + ", Full Received TZ: " + easTZ.toString());
        }

        let tzService = cal.getTimezoneService();
        if (data.StartTime) {
            let utc = cal.createDateTime(data.StartTime); //format "19800101T000000Z" - UTC
            item.startDate = utc.getInTimezone(tzService.getTimezone(eas.offsets[utcOffset]));
        }

        if (data.EndTime) {
            let utc = cal.createDateTime(data.EndTime);
            item.endDate = utc.getInTimezone(tzService.getTimezone(eas.offsets[utcOffset]));
        }

        //stamp time cannot be set and it is not needed, an updated version is only send to the server, if there was a change, so stamp will be updated

        //check if alldate and fix values
        if (data.AllDayEvent && data.AllDayEvent == "1") {
            item.startDate.isDate = true;
            item.endDate.isDate = true;
        }

        //EAS Reminder
        item.clearAlarms();
        if (data.Reminder) {
            let alarm = cal.createAlarm();
            alarm.related = Components.interfaces.calIAlarm.ALARM_RELATED_START;
            alarm.offset = cal.createDuration();
            alarm.offset.inSeconds = (0-parseInt(data.Reminder)*60);
            alarm.action = "DISPLAY";
            item.addAlarm(alarm);
        }

        eas.sync.mapEasPropertyToThunderbird ("BusyStatus", "TRANSP", data, item);
        eas.sync.mapEasPropertyToThunderbird ("Sensitivity", "CLASS", data, item);

        if (data.ResponseType) {
            //store original EAS value 
            item.setProperty("X-EAS-ResponseType", data.ResponseType);
        }

        //Attendees - remove all Attendees and re-add the ones from XML
        item.removeAllAttendees();
        if (data.Attendees && data.Attendees.Attendee) {
            let att = [];
            if (Array.isArray(data.Attendees.Attendee)) att = data.Attendees.Attendee;
            else att.push(data.Attendees.Attendee);
            for (let i = 0; i < att.length; i++) {

                let attendee = cal.createAttendee();

                //is this attendee the local EAS user?
                let isSelf = (att[i].Email == tbSync.db.getAccountSetting(syncdata.account, "user"));
                
                attendee["id"] = cal.prependMailTo(att[i].Email);
                attendee["commonName"] = att[i].Name;
                //default is "FALSE", only if THIS attendee isSelf, use ResponseRequested (we cannot respond for other attendee) - ResponseType is not send back to the server, it is just a local information
                attendee["rsvp"] = (isSelf && data.ResponseRequested) ? "TRUE" : "FALSE";		

                //not supported in 2.5
                switch (att[i].AttendeeType) {
                    case "1": //required
                        attendee["role"] = "REQ-PARTICIPANT";
                        attendee["userType"] = "INDIVIDUAL";
                        break;
                    case "2": //optional
                        attendee["role"] = "OPT-PARTICIPANT";
                        attendee["userType"] = "INDIVIDUAL";
                        break;
                    default : //resource or unknown
                        attendee["role"] = "NON-PARTICIPANT";
                        attendee["userType"] = "RESOURCE";
                        break;
                }

                //not supported in 2.5 - if attendeeStatus is missing, check if this isSelf and there is a ResponseType
                if (att[i].AttendeeStatus)
                    attendee["participationStatus"] = eas.sync.MAP_EAS2TB.ATTENDEESTATUS[att[i].AttendeeStatus];
                else if (isSelf && data.ResponseType) 
                    attendee["participationStatus"] = eas.sync.MAP_EAS2TB.ATTENDEESTATUS[data.ResponseType];
                else 
                    attendee["participationStatus"] = "NEEDS-ACTION";

                // status  : [NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE, DELEGATED, COMPLETED, IN-PROCESS]
                // rolemap : [REQ-PARTICIPANT, OPT-PARTICIPANT, NON-PARTICIPANT, CHAIR]
                // typemap : [INDIVIDUAL, GROUP, RESOURCE, ROOM]

                // Add attendee to event
                item.addAttendee(attendee);
            }
        }
        
        if (data.OrganizerName && data.OrganizerEmail) {
            //Organizer
            let organizer = cal.createAttendee();
            organizer.id = cal.prependMailTo(data.OrganizerEmail);
            organizer.commonName = data.OrganizerName;
            organizer.rsvp = "FALSE";
            organizer.role = "CHAIR";
            organizer.userType = null;
            organizer.participationStatus = "ACCEPTED";
            organizer.isOrganizer = true;
            item.organizer = organizer;
        }

        eas.sync.setItemRecurrence(item, syncdata, data);

        if (data.MeetingStatus) {
            //store original EAS value 
            item.setProperty("X-EAS-MeetingStatus", data.MeetingStatus);
            //bitwise representation for Meeting, Received, Cancelled:
            let M = data.MeetingStatus & 0x1;
            let R = data.MeetingStatus & 0x2;
            let C = data.MeetingStatus & 0x4;
            
            //we can map M+C to TB STATUS (TENTATIVE, CONFIRMED, CANCELLED, unset)
            //if it is not a meeting -> unset
            //if it is a meeting -> CANCELLED or CONFIRMED
            if (M) item.setProperty("STATUS", (C ? "CANCELLED" : "CONFIRMED"));
            else item.deleteProperty("STATUS");
            
            //we can also use the R information, to update our fallbackOrganizerName
            if (!R && data.OrganizerName) syncdata.targetObj.setProperty("fallbackOrganizerName", data.OrganizerName);            
        }

        //TODO: attachements (needs EAS 16.0!)

    },









    // --------------------------------------------------------------------------- //
    //read TB event and return its data as WBXML
    // --------------------------------------------------------------------------- //
    getWbxmlFromThunderbirdItem: function (item, syncdata, isException = false) {
        let asversion = tbSync.db.getAccountSetting(syncdata.account, "asversion");
        let wbxml = tbSync.wbxmltools.createWBXML("", syncdata.type); //init wbxml with "" and not with precodes, and set initial codepage
        
        /*
         *  We do not use ghosting, that means, if we do not include a value in CHANGE, it is removed from the server. 
         *  However, this does not seem to work on all fields. Furthermore, we need to include any (empty) container to blank its childs.
         */
        
        //each TB event has an ID, which is used as EAS serverId - however there is a second UID in the ApplicationData
        //since we do not have two different IDs to use, we use the same ID
        if (!isException) { //docs say it would be allowed in exception in 2.5, but it does not work, if present
            wbxml.atag("UID", item.id);
        }
        //IMPORTANT in EAS v16 it is no longer allowed to send a UID
        //Only allowed in exceptions in v2.5

        // REQUIRED FIELDS
        let tz = eas.getEasTimezoneData(item);
        if (!isException) {
            wbxml.atag("TimeZone", tz.timezone);
        }

        //StartTime & EndTime in UTC
        wbxml.atag("StartTime", tz.startDateUTC);
        wbxml.atag("EndTime", tz.endDateUTC);

        //DtStamp
        wbxml.atag("DtStamp", tz.stampTimeUTC);
        
        //obmitting these, should remove them from the server - that does not work reliably, so we send blanks
        wbxml.atag("Subject", (item.title) ? tbSync.encode_utf8(item.title) : "");
        wbxml.atag("Location", (item.hasProperty("location")) ? tbSync.encode_utf8(item.getProperty("location")) : "");
        
        //Categories (see https://github.com/jobisoft/TbSync/pull/35#issuecomment-359286374)
        if (!isException) {
            wbxml.append(eas.sync.getItemCategories(item, syncdata));
        }
        
        //TP PRIORITY (9=LOW, 5=NORMAL, 1=HIGH) not mapable to EAS Event
        
        //Organizer
        if (!isException) {
            if (item.organizer && item.organizer.commonName) wbxml.atag("OrganizerName", item.organizer.commonName);
            if (item.organizer && item.organizer.id) wbxml.atag("OrganizerEmail",  cal.removeMailTo(item.organizer.id));
        }

        //Attendees
        let TB_responseType = null;
        let countAttendees = {};
        let attendees = item.getAttendees(countAttendees);
        
        if (!(isException && asversion == "2.5")) { //attendees are not supported in exceptions in EAS 2.5
            if (countAttendees.value > 0) {
                wbxml.otag("Attendees");
                    for (let attendee of attendees) {
                        wbxml.otag("Attendee");
                            wbxml.atag("Email", cal.removeMailTo(attendee.id));
                            wbxml.atag("Name", (attendee.commonName ? attendee.commonName : cal.removeMailTo(attendee.id).split("@")[0]));
                            if (asversion != "2.5") {
                                //it's pointless to send AttendeeStatus, 
                                // - if we are the owner of a meeting, TB does not have an option to actually set the attendee status (on behalf of an attendee) in the UI
                                // - if we are an attendee (of an invite) we cannot and should not set status of other attendees and or own status must be send through a MeetingResponse
                                // -> all changes of attendee status are send from the server to us, either via ResponseType or via AttendeeStatus
                                //wbxml.atag("AttendeeStatus", eas.sync.MAP_TB2EAS.ATTENDEESTATUS[attendee.participationStatus]);

                                if (attendee.userType == "RESOURCE" || attendee.userType == "ROOM" || attendee.role == "NON-PARTICIPANT") wbxml.atag("AttendeeType","3");
                                else if (attendee.role == "REQ-PARTICIPANT" || attendee.role == "CHAIR") wbxml.atag("AttendeeType","1");
                                else wbxml.atag("AttendeeType","2"); //leftovers are optional
                            }
                        wbxml.ctag();
                    }
                wbxml.ctag();
            } else {
                wbxml.atag("Attendees");
            }
        }

        //TODO: attachements (needs EAS 16.0!)

        //recurrent events (implemented by Chris Allan)
        if (!isException) {
            wbxml.append(eas.sync.getItemRecurrence(item, syncdata));
        }
        
        //Description
        wbxml.append(eas.sync.getItemBody(item, syncdata));

        //TRANSP / BusyStatus
        wbxml.atag("BusyStatus", eas.sync.mapThunderbirdPropertyToEas("TRANSP", "BusyStatus", item));
        
        //CLASS / Sensitivity
        wbxml.atag("Sensitivity", eas.sync.mapThunderbirdPropertyToEas("CLASS", "Sensitivity", item));
        
        //for simplicity, we always send a value for AllDayEvent
        wbxml.atag("AllDayEvent", (item.startDate.isDate && item.endDate.isDate) ? "1" : "0");
 
        //EAS Reminder (TB getAlarms) - at least with zpush blanking by omitting works, horde does not work
        let alarms = item.getAlarms({});
        if (alarms.length>0) wbxml.atag("Reminder", (0 - alarms[0].offset.inSeconds/60).toString());
        //https://dxr.mozilla.org/comm-central/source/calendar/base/public/calIAlarm.idl
        //tbSync.dump("ALARM ("+i+")", [, alarms[i].related, alarms[i].repeat, alarms[i].repeatOffset, alarms[i].repeatDate, alarms[i].action].join("|"));

            //EAS MeetingStatus
        // 0 (000) The event is an appointment, which has no attendees.
        // 1 (001) The event is a meeting and the user is the meeting organizer.
        // 3 (011) This event is a meeting, and the user is not the meeting organizer; the meeting was received from someone else.
        // 5 (101) The meeting has been canceled and the user was the meeting organizer.
        // 7 (111) The meeting has been canceled. The user was not the meeting organizer; the meeting was received from someone else

        //there are 3 fields; Meeting, Owner, Cancelled
        //M can be reconstructed from #of attendees (looking at the old value is not wise, since it could have been changed)
        //C can be reconstucted from TB STATUS
        //O can be reconstructed by looking at the original value, or (if not present) by comparing EAS ownerID with TB ownerID

        if (!(isException && asversion == "2.5")) { //MeetingStatus is not supported in exceptions in EAS 2.5        
            if (countAttendees == 0) wbxml.atag("MeetingStatus", "0");
            else {
                //get owner information
                let isReceived = false;
                if (item.hasProperty("X-EAS-MEETINGSTATUS")) isReceived = item.getProperty("X-EAS-MEETINGSTATUS") & 0x2;
                else isReceived = (item.organizer && item.organizer.id && cal.removeMailTo(item.organizer.id) != tbSync.db.getAccountSetting(syncdata.account, "user"));

                //either 1,3,5 or 7
                if (item.hasProperty("STATUS") && item.getProperty("STATUS") == "CANCELLED") {
                    //either 5 or 7
                    wbxml.atag("MeetingStatus", (isReceived ? "7" : "5"));
                } else {
                    //either 1 or 3
                    wbxml.atag("MeetingStatus", (isReceived ? "3" : "1"));
                }
            }
        }

        return wbxml.getBytes();
    }
    
    
        /*
        //loop over all properties
        let propEnum = item.propertyEnumerator;
        while (propEnum.hasMoreElements()) {
            let prop = propEnum.getNext().QueryInterface(Components.interfaces.nsIProperty);
            let pname = prop.name;
            tbSync.dump("PROP", pname + " = " + prop.value);
        }
        */
    
}
