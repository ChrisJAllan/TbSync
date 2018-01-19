"use strict";

eas.calendarsync = {

    /* 
        Status TODO:
        
        TB allows to set status of organizer (accept, decline etc.) which cannot be mapped to EAS.
        I do not know, if EAS needs the organizer added as attendee, if he actually DOES NOT take part in the meeting
        To make things simple, we could just hide the menu item which would allow the user to change status of organizer.
    
        A few settings cannot be changed with (some) EAS implementations:
            - MeetingStatus (cancelled/active)
            - AttendeeStatus (accept, declined etc.)
        because these information need to be passed to ALL attendees, so just changing them in the users own calendar is not enough. 
        The client has to send an email to all attendees which is interpreted by the attendees EAS server, which changes the values in the attendees calendar.
    
        Can we do that via EAS SendMail in the background? EAS - Notifcations should be send at:
            - M delete by orga (cancel M, but do not actually delete, let the server handle that) 
            - I delete by attendee (decline M, but do not actually delete, let the server handle that)
            - M set to cancel by orga

        TB notification - if the owner editted the meeting - are send via IMAP, which req the IMAP account to be present. Disable TB notification and use EAS notifications as well?
*/
    
    
    start: Task.async (function* (syncdata)  {
        // skip if lightning is not installed
        if ("calICalendar" in Components.interfaces == false) {
            throw eas.finishSync("nolightning", eas.flags.abortWithError);
        }
        
        // check SyncTarget
        if (!tbSync.checkCalender(syncdata.account, syncdata.folderID)) {
            throw eas.finishSync("notargets", eas.flags.abortWithError);
        }
        
        //get sync target of this calendar
        syncdata.targetObj = cal.getCalendarManager().getCalendarById(tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "target"));
        syncdata.targetId = syncdata.targetObj.id;

        //sync
        yield eas.calendarsync.requestRemoteChanges (syncdata); 
        yield eas.calendarsync.sendLocalChanges (syncdata);
        
        //if everything was OK, we still throw, to get into catch
        throw eas.finishSync();
    }),



    
    requestRemoteChanges: Task.async (function* (syncdata)  {
        do {
            tbSync.setSyncState("requestingchanges", syncdata.account, syncdata.folderID);

            // BUILD WBXML
            let wbxml = tbSync.wbxmltools.createWBXML();
            wbxml.otag("Sync");
                wbxml.otag("Collections");
                    wbxml.otag("Collection");
                        if (tbSync.db.getAccountSetting(syncdata.account, "asversion") == "2.5") wbxml.atag("Class", syncdata.type);
                        wbxml.atag("SyncKey", syncdata.synckey);
                        wbxml.atag("CollectionId", syncdata.folderID);
                        wbxml.atag("DeletesAsMoves", "1");
                        //wbxml.atag("GetChanges", ""); //Not needed, as it is default
                        wbxml.atag("WindowSize", "100");

                        if (tbSync.db.getAccountSetting(syncdata.account, "asversion") != "2.5") {
                            wbxml.otag("Options");
                                wbxml.switchpage("AirSyncBase");
                                wbxml.otag("BodyPreference");
                                    wbxml.atag("Type", "1");
                                wbxml.ctag();
                                wbxml.switchpage("AirSync");
                            wbxml.ctag();
                        }

                    wbxml.ctag();
                wbxml.ctag();
            wbxml.ctag();



            //SEND REQUEST
            let response = yield eas.sendRequest(wbxml.getBytes(), "Sync", syncdata);



            //VALIDATE RESPONSE
            tbSync.setSyncState("recievingchanges", syncdata.account, syncdata.folderID);

            // get data from wbxml response, some servers send empty response if there are no changes, which is not an error
            let wbxmlData = eas.getDataFromResponse(response, eas.flags.allowEmptyResponse);
            if (wbxmlData === null) return;
        
            //check status, throw on error
            eas.checkStatus(syncdata, wbxmlData,"Sync.Collections.Collection.Status");
            
            //update synckey, throw on error
            eas.updateSynckey(syncdata, wbxmlData);



            //PROCESS RESPONSE        
            //any commands for us to work on? If we reach this point, Sync.Collections.Collection is valid, 
            //no need to use the save getWbxmlDataField function
            if (wbxmlData.Sync.Collections.Collection.Commands) {

                //promisify calender, so it can be used together with yield
                let pcal = cal.async.promisifyCalendar(syncdata.targetObj.wrappedJSObject);
            
                //looking for additions
                let add = xmltools.nodeAsArray(wbxmlData.Sync.Collections.Collection.Commands.Add);
                for (let count = 0; count < add.length; count++) {

                    let ServerId = add[count].ServerId;
                    let data = add[count].ApplicationData;

                    let foundItems = yield pcal.getItem(ServerId);
                    if (foundItems.length == 0) { //do NOT add, if an item with that ServerId was found
                        //if this is a resync and this item exists in delete_log, do not add it, the follow-up delete request will remove it from the server as well
                        if (db.getItemStatusFromChangeLog(syncdata.targetObj.id, ServerId) == "deleted_by_user") {
                            tbSync.dump("Add request, but element is in delete_log, asuming resync, local state wins, not adding.", ServerId);
                        } else {
                            let newItem = cal.createEvent();
                            eas.calendarsync.setCalendarItemFromWbxml(newItem, data, ServerId, syncdata);
                            db.addItemToChangeLog(syncdata.targetObj.id, ServerId, "added_by_server");
                            try {
                                yield pcal.addItem(newItem);
                            } catch (e) {tbSync.dump("Error during Add", e);}
                        }
                    } else {
                        //item exists, asuming resync
                        tbSync.dump("Add request, but element exists already, asuming resync, local version wins.", ServerId);
                        //we MUST make sure, that our local version is send to the server
                        db.addItemToChangeLog(syncdata.targetObj.id, ServerId, "modified_by_user");
                    }
                }

                //looking for changes
                let upd = xmltools.nodeAsArray(wbxmlData.Sync.Collections.Collection.Commands.Change);
                //inject custom change object for debug
                //upd = JSON.parse('[{"ServerId":"2tjoanTeS0CJ3QTsq5vdNQAAAAABDdrY6Gp03ktAid0E7Kub3TUAAAoZy4A1","ApplicationData":{"DtStamp":"20171109T142149Z"}}]');
                for (let count = 0; count < upd.length; count++) {

                    let ServerId = upd[count].ServerId;
                    let data = upd[count].ApplicationData;

                    let foundItems = yield pcal.getItem(ServerId);
                    if (foundItems.length > 0) { //only update, if an item with that ServerId was found
                        let newItem = foundItems[0].clone();
                        eas.calendarsync.setCalendarItemFromWbxml(newItem, data, ServerId, syncdata);
                        db.addItemToChangeLog(syncdata.targetObj.id, ServerId, "modified_by_server");
                        yield pcal.modifyItem(newItem, foundItems[0]);
                    } else {
                        tbSync.dump("Update request, but element not found", ServerId);
                        //resync to avoid out-of-sync problems, "add" can take care of local merges
                        throw eas.finishSync("ChangeElementNotFound", eas.flags.resyncFolder);
                    }
                }
                
                //looking for deletes
                let del = xmltools.nodeAsArray(wbxmlData.Sync.Collections.Collection.Commands.Delete);
                for (let count = 0; count < del.length; count++) {

                    let ServerId = del[count].ServerId;

                    let foundItems = yield pcal.getItem(ServerId);
                    if (foundItems.length > 0) { //delete item with that ServerId
                        db.addItemToChangeLog(syncdata.targetObj.id, ServerId, "deleted_by_server");
                        yield pcal.deleteItem(foundItems[0]);
                    } else {
                        tbSync.dump("Delete request, but element not found", ServerId);
                        //resync to avoid out-of-sync problems
                        throw eas.finishSync("DeleteElementNotFound", eas.flags.resyncFolder);
                    }
                }
            
            }
            
            if (!wbxmlData.Sync.Collections.Collection.MoreAvailable) return;
        } while (true);
                
    }),




    sendLocalChanges: Task.async (function* (syncdata)  {

        //promisify calender, so it can be used together with yield
        let pcal = cal.async.promisifyCalendar(syncdata.targetObj.wrappedJSObject);
        let maxnumbertosend = tbSync.prefSettings.getIntPref("maxnumbertosend");
        
        //get changed items from ChangeLog
        do {
            tbSync.setSyncState("sendingchanges", syncdata.account, syncdata.folderID);
            let changes = db.getItemsFromChangeLog(syncdata.targetObj.id, maxnumbertosend, "_by_user");
            let c=0;
            
            // BUILD WBXML
            let wbxml = tbSync.wbxmltools.createWBXML();
            wbxml.otag("Sync");
                wbxml.otag("Collections");
                    wbxml.otag("Collection");
                        if (tbSync.db.getAccountSetting(syncdata.account, "asversion") == "2.5") wbxml.atag("Class", syncdata.type);
                        wbxml.atag("SyncKey", syncdata.synckey);
                        wbxml.atag("CollectionId", syncdata.folderID);
                        wbxml.otag("Commands");

                            for (let i=0; i<changes.length; i++) {
                                //tbSync.dump("CHANGES",(i+1) + "/" + changes.length + " ("+changes[i].status+"," + changes[i].id + ")");
                                let items = null;
                                switch (changes[i].status) {

                                    case "added_by_user":
                                        items = yield pcal.getItem(changes[i].id);
                                        wbxml.otag("Add");
                                        wbxml.atag("ClientId", changes[i].id); //ClientId is an id generated by Thunderbird, which will get replaced by an id generated by the server
                                            wbxml.otag("ApplicationData");
                                                wbxml.append(eas.calendarsync.getWbxmlFromCalendarItem(items[0], syncdata));
                                            wbxml.ctag();
                                        wbxml.ctag();
                                        db.removeItemFromChangeLog(syncdata.targetObj.id, changes[i].id);
                                        c++;
                                        break;
                                    
                                    case "modified_by_user":
                                        items = yield pcal.getItem(changes[i].id);
                                        wbxml.otag("Change");
                                        wbxml.atag("ServerId", changes[i].id);
                                            wbxml.otag("ApplicationData");
                                                wbxml.append(eas.calendarsync.getWbxmlFromCalendarItem(items[0], syncdata));
                                            wbxml.ctag();
                                        wbxml.ctag();
                                        db.removeItemFromChangeLog(syncdata.targetObj.id, changes[i].id);
                                        c++;
                                        break;
                                    
                                    case "deleted_by_user":
                                        wbxml.otag("Delete");
                                            wbxml.atag("ServerId", changes[i].id);
                                        wbxml.ctag();
                                        db.removeItemFromChangeLog(syncdata.targetObj.id, changes[i].id);
                                        c++;
                                        break;
                                }
                            }

                        wbxml.ctag(); //Commands
                    wbxml.ctag(); //Collection
                wbxml.ctag(); //Collections
            wbxml.ctag(); //Sync

            //if there was not a single local change, exit
            if (c == 0) {
                if (changes !=0 ) tbSync.dump("noMoreChanges, but unproceccessed changes left:", changes);
                return;
            }



            //SEND REQUEST & VALIDATE RESPONSE
            let response = yield eas.sendRequest(wbxml.getBytes(), "Sync", syncdata);

            tbSync.setSyncState("serverid", syncdata.account, syncdata.folderID);

            //get data from wbxml response
            let wbxmlData = eas.getDataFromResponse(response);
        
            //check status
            eas.checkStatus(syncdata, wbxmlData,"Sync.Collections.Collection.Status");
            
            //update synckey
            eas.updateSynckey(syncdata, wbxmlData);



            //PROCESS RESPONSE        
            //any responses for us to work on?  If we reach this point, Sync.Collections.Collection is valid, 
            //no need to use the save getWbxmlDataField function
            if (wbxmlData.Sync.Collections.Collection.Responses) {                

                //looking for additions (Add node contains, status, old ClientId and new ServerId)
                let add = xmltools.nodeAsArray(wbxmlData.Sync.Collections.Collection.Responses.Add);
                for (let count = 0; count < add.length; count++) {
                    
                    //Check status, stop sync if bad (statusIsBad will initiate a resync or finish the sync properly)
                    eas.checkStatus(syncdata, add[count],"Status","Sync.Collections.Collection.Responses.Add["+count+"].Status");

                    //look for an item identfied by ClientId and update its id to the new id received from the server
                    let foundItems = yield pcal.getItem(add[count].ClientId);
                    
                    if (foundItems.length > 0) {
                        let newItem = foundItems[0].clone();
                        newItem.id = add[count].ServerId;
                        db.addItemToChangeLog(syncdata.targetObj.id, newItem.id, "modified_by_server");
                        yield pcal.modifyItem(newItem, foundItems[0]);
                    }
                }

                //looking for modifications 
                let upd = xmltools.nodeAsArray(wbxmlData.Sync.Collections.Collection.Responses.Change);
                for (let count = 0; count < upd.length; count++) {
                    //Check status, stop sync if bad (statusIsBad will initiate a resync or finish the sync properly)
                    eas.checkStatus(syncdata, upd[count],"Status","Sync.Collections.Collection.Responses.Change["+count+"].Status");
                }

                //looking for deletions 
                let del = xmltools.nodeAsArray(wbxmlData.Sync.Collections.Collection.Responses.Delete);
                for (let count = 0; count < del.length; count++) {
                    //Check status, stop sync if bad (statusIsBad will initiate a resync or finish the sync properly)
                    eas.checkStatus(syncdata, del[count],"Status","Sync.Collections.Collection.Responses.Delete["+count+"].Status");
                }
                
            }
        } while (true);
        
    }),






    //FUNCTIONS TO ACTUALLY READ FROM AND WRITE TO CALENDAR ITEMS

    //EAS Sensitivity :  0 = Normal  |  1 = Personal  |  2 = Private  |  3 = Confidential
    //TB CLASS: PUBLIC, PRIVATE, CONFIDENTIAL)
    MAP_EAS_SENSITIVITY : { "0":"PUBLIC", "1":"unset", "2":"PRIVATE", "3":"CONFIDENTIAL"},
    MAP_TB_CLASS : { "PUBLIC":"0", "PRIVATE":"2", "CONFIDENTIAL":"3", "unset":"1"},

    //EAS BusyStatus:  0 = Free  |  1 = Tentative  |  2 = Busy  |  3 = Work  |  4 = Elsewhere
    //TB TRANSP : free = TRANSPARENT, busy = OPAQUE)
    MAP_EAS_BUSYSTATUS : {"0":"TRANSPARENT", "1":"unset", "2":"OPAQUE", "3":"OPAQUE", "4":"OPAQUE"},
    MAP_TB_TRANSP : {"TRANSPARENT":"0", "unset":"1", "OPAQUE":"2"},

    //EAS AttendeeStatus: 0 =Response unknown (but needed) |  2 = Tentative  |  3 = Accept  |  4 = Decline  |  5 = Not responded (and not needed) || 1 = Organizer in ResponseType
    //TB STATUS: NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE, DELEGATED, COMPLETED, IN-PROCESS
    MAP_EAS_ATTENDEESTATUS : {"0": "NEEDS-ACTION", "1":"Orga", "2":"TENTATIVE", "3":"ACCEPTED", "4":"DECLINED", "5":"COMPLETED"},
    MAP_TB_ATTENDEESTATUS : {"NEEDS-ACTION":"0", "ACCEPTED":"3", "DECLINED":"4", "TENTATIVE":"2", "DELEGATED":"5","COMPLETED":"5", "IN-PROCESS":"5"},



    getItemPropertyWithFallback: function (item, TB_PROP, EAS_PROP, MAP_TB, MAP_EAS) {
        if (item.hasProperty(EAS_PROP) && tbSync.getCalItemProperty(item, TB_PROP) == MAP_EAS[item.getProperty(EAS_PROP)]) {
            //we can use our stored EAS value, because it still maps to the current TB value
            return item.getProperty(EAS_PROP);
        } else {
            return MAP_TB[tbSync.getCalItemProperty(item, TB_PROP)]; 
        }
    },

    
    
    //insert data from wbxml object into a TB event item
    setCalendarItemFromWbxml: function (item, data, id, syncdata) {
        
        let asversion = tbSync.db.getAccountSetting(syncdata.account, "asversion");
        item.id = id;
        let easTZ = new eas.TimeZoneDataStructure();

        if (data.Subject) item.title = xmltools.checkString(data.Subject);
        if (data.Location) item.setProperty("location", xmltools.checkString(data.Location));
        if (data.Categories && data.Categories.Category) {
            let cats = [];
            if (Array.isArray(data.Categories.Category)) cats = data.Categories.Category;
            else cats.push(data.Categories.Category);
            item.setCategories(cats.length, cats);
        }

        if (asversion == "2.5") {
            if (data.Body) item.setProperty("description", xmltools.checkString(data.Body));
        } else {
            if (data.Body && data.Body.EstimatedDataSize > 0 && data.Body.Data) item.setProperty("description", xmltools.checkString(data.Body.Data)); //CLEAR??? DataSize>0 ??
        }
        
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

        if (data.BusyStatus) {
            //store original EAS value 
            item.setProperty("X-EAS-BusyStatus", data.BusyStatus);
            //map EAS value to TB value (use setCalItemProperty if there is one option which can unset/delete the property)
            tbSync.setCalItemProperty(item, "TRANSP", this.MAP_EAS_BUSYSTATUS[data.BusyStatus]);
        }

        if (data.Sensitivity) {
            //store original EAS value 
            item.setProperty("X-EAS-Sensitivity", data.Sensitivity);
            //map EAS value to TB value  (use setCalItemProperty if there is one option which can unset/delete the property)
            tbSync.setCalItemProperty(item,"CLASS", this.MAP_EAS_SENSITIVITY[data.Sensitivity]);
        }

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
                    attendee["participationStatus"] = this.MAP_EAS_ATTENDEESTATUS[att[i].AttendeeStatus];
                else if (isSelf && data.ResponseType) 
                    attendee["participationStatus"] = this.MAP_EAS_ATTENDEESTATUS[data.ResponseType];
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

        if (data.Recurrence) {
            item.recurrenceInfo = cal.createRecurrenceInfo();
            item.recurrenceInfo.item = item;
            let recRule = cal.createRecurrenceRule();
            switch (data.Recurrence.Type) {
            case "0":
                recRule.type = "DAILY";
                break;
            case "1":
                recRule.type = "WEEKLY";
                break;
            case "2":
            case "3":
                recRule.type = "MONTHLY";
                break;
            case "5":
            case "6":
                recRule.type = "YEARLY";
                break;
            }
            if (data.Recurrence.CalendarType) {
                // TODO
            }
            if (data.Recurrence.DayOfMonth) {
                recRule.setComponent("BYMONTHDAY", 1, [data.Recurrence.DayOfMonth]);
            }
            if (data.Recurrence.DayOfWeek) {
                let DOW = data.Recurrence.DayOfWeek;
                if (DOW == 127) {
                    recRule.setComponent("BYMONTHDAY", 1, [-1]);
                }
                else {
                    let days = [];
                    for (let i = 0; i < 7; ++i) {
                        if (DOW & 1 << i) days.push(i + 1);
                    }
                    if (data.Recurrence.WeekOfMonth) {
                        for (let i = 0; i < days.length; ++i) {
                            days[i] += 8 * ((data.Recurrence.WeekOfMonth != 5) ? (data.Recurrence.WeekOfMonth - 0) : -1);
                        }
                    }
                    recRule.setComponent("BYDAY", days.length, days);
                }
            }
            if (data.Recurrence.FirstDayOfWeek) {
                recRule.setComponent("WKST", 1, [data.Recurrence.FirstDayOfWeek]);
            }
            if (data.Recurrence.Interval) {
                recRule.interval = data.Recurrence.Interval;
            }
            if (data.Recurrence.IsLeapMonth) {
                // TODO
            }
            if (data.Recurrence.MonthOfYear) {
                recRule.setComponent("BYMONTH", 1, [data.Recurrence.MonthOfYear]);
            }
            if (data.Recurrence.Occurrences) {
                recRule.count = data.Recurrence.Occurrences;
            }
            if (data.Recurrence.Until) {
                recRule.untilDate = cal.createDateTime(data.Recurrence.Until);
            }
            item.recurrenceInfo.insertRecurrenceItemAt(recRule, 0);
            if (data.Exceptions) {
                // Exception could be an object or an array of objects
                let exceptions = [].concat(data.Exceptions.Exception);
                for (let exception of exceptions) {
                    let dateTime = cal.createDateTime(exception.ExceptionStartTime);
                    if (data.AllDayEvent == "1") {
                        dateTime.isDate = true;
                    }
                    if (exception.Deleted == "1") {
                        item.recurrenceInfo.removeOccurrenceAt(dateTime);
                    }
                }
            }
        }

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
        //TODO: exceptions to recurrence

        //TASK STUFF
        //aItem.entryDate = start;
        //aItem.dueDate = aEndDate.clone();
        //due.addDuration(dueOffset);
    },






    //read TB event and return its data as WBXML
    getWbxmlFromCalendarItem: function (item, syncdata) {
        let asversion = tbSync.db.getAccountSetting(syncdata.account, "asversion");
        let wbxml = tbSync.wbxmltools.createWBXML(""); //init wbxml with "" and not with precodes
        
        /*
         *  We do not use ghosting, that means, if we do not include a value in CHANGE, it is removed from the server. 
         *  However, this does not seem to work on all fields. Furthermore, we need to include any (empty) container to blank its childs.
         */

        wbxml.switchpage("Calendar");
        
        //each TB event has an ID, which is used as EAS serverId - however there is a second UID in the ApplicationData
        //since we do not have two different IDs to use, we use the same ID
        wbxml.atag("UID", item.id);
        //IMPORTANT in EAS v16 it is no longer allowed to send a UID

        // REQUIRED FIELDS
        let tz = eas.getEasTimezoneData(item);
        wbxml.atag("TimeZone", tz.timezone);

        //StartTime & EndTime in UTC
        wbxml.atag("StartTime", tz.startDateUTC);
        wbxml.atag("EndTime", tz.endDateUTC);

        //DtStamp
        wbxml.atag("DtStamp", tz.stampTimeUTC);
        
        //obmitting these, should remove them from the server - that does not work reliably, so we send blanks
        wbxml.atag("Subject", (item.title) ? tbSync.encode_utf8(item.title) : "");
        wbxml.atag("Location", (item.hasProperty("location")) ? tbSync.encode_utf8(item.getProperty("location")) : "");
        
        //categories, to properly "blank" them, we need to always include the container
        let categories = item.getCategories({});
        if (categories.length > 0) {
            wbxml.otag("Categories");
                for (let i=0; i<categories.length; i++) wbxml.atag("Category", tbSync.encode_utf8(categories[i]));
            wbxml.ctag();
        } else {
            wbxml.atag("Categories");
        }

        //TP PRIORITY (9=LOW, 5=NORMAL, 1=HIGH) not mapable to EAS
        
        //Organizer
        if (item.organizer && item.organizer.commonName) wbxml.atag("OrganizerName", item.organizer.commonName);
        if (item.organizer && item.organizer.id) wbxml.atag("OrganizerEmail",  cal.removeMailTo(item.organizer.id));

        //Attendees
        let TB_responseType = null;
        let countAttendees = {};
        let attendees = item.getAttendees(countAttendees);
        
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
                            //wbxml.atag("AttendeeStatus", this.MAP_TB_ATTENDEESTATUS[attendee.participationStatus]);
                            
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

        //TODO: attachements (needs EAS 16.0!)
        //TODO: exceptions to recurrence

        //recurrent events (implemented by Chris Allan)
        if (item.recurrenceInfo) {
            let deleted = [];
            for (let recRule of item.recurrenceInfo.getRecurrenceItems({})) {
                if (recRule.isNegative) {
                    deleted.push(recRule);
                    continue;
                }
                wbxml.otag("Recurrence");
                let type = 0;
                let monthDays = recRule.getComponent("BYMONTHDAY", {});
                let weekDays  = recRule.getComponent("BYDAY", {});
                let months    = recRule.getComponent("BYMONTH", {});
                //proposed change by Chris Allan
                //let weeks     = recRule.getComponent("BYWEEKNO", {});
                let weeks     = [];
                // Unpack 1MO style days
                for (let i = 0; i < weekDays.length; ++i) {
                    if (weekDays[i] > 8) {
                        weeks[i] = Math.floor(weekDays[i] / 8);
                        weekDays[i] = weekDays[i] % 8;
                    }
                    else if (weekDays[i] < -8) {
                        // EAS only supports last week as a special value, treat
                        // all as last week or assume every month has 5 weeks?
                        // Change to last week
                        //weeks[i] = 5;
                        // Assumes 5 weeks per month for week <= -2
                        weeks[i] = 6 - Math.floor(-weekDays[i] / 8);
                        weekDays[i] = -weekDays[i] % 8;
                    }
                }
                if (monthDays[0] && monthDays[0] == -1) {
                    weeks = [5];
                    weekDays = [1, 2, 3, 4, 5, 6, 7]; // 127
                    monthDays[0] = null;
                }
                // Type
                if (recRule.type == "WEEKLY") {
                    type = 1;
                    if (!weekDays.length) {
                        weekDays = [item.startDate.weekday + 1];
                    }
                }
                else if (recRule.type == "MONTHLY" && weeks.length) {
                    type = 3;
                }
                else if (recRule.type == "MONTHLY") {
                    type = 2;
                    if (!monthDays.length) {
                        monthDays = [item.startDate.day];
                    }
                }
                else if (recRule.type == "YEARLY" && weeks.length) {
                    type = 6;
                }
                else if (recRule.type == "YEARLY") {
                    type = 5;
                    if (!monthDays.length) {
                        monthDays = [item.startDate.day];
                    }
                    if (!months.length) {
                        months = [item.startDate.month + 1];
                    }
                }
                wbxml.atag("Type", type.toString());
                // TODO: CalendarType: 14.0 and up
                // DayOfMonth
                if (monthDays[0]) {
                    // TODO: Multiple days of month - multiple Recurrence tags?
                    wbxml.atag("DayOfMonth", monthDays[0].toString());
                }
                // DayOfWeek
                if (weekDays.length) {
                    let bitfield = 0;
                    for (let day of weekDays) {
                        bitfield |= 1 << (day - 1);
                    }
                    wbxml.atag("DayOfWeek", bitfield.toString());
                }
                // FirstDayOfWeek: 14.1 and up
                //wbxml.atag("FirstDayOfWeek", recRule.weekStart);
                // Interval
                wbxml.atag("Interval", recRule.interval.toString());
                // TODO: IsLeapMonth: 14.0 and up
                // MonthOfYear
                if (months.length) {
                    wbxml.atag("MonthOfYear", months[0].toString());
                }
                // Occurrences
                if (recRule.isByCount) {
                    wbxml.atag("Occurrences", recRule.count.toString());
                }
                // Until
                else if (recRule.untilDate != null) {
                    wbxml.atag("Until", recRule.untilDate.getInTimezone(cal.UTC()).icalString);
                }
                // WeekOfMonth
                if (weeks.length) {
                    wbxml.atag("WeekOfMonth", weeks[0].toString());
                }
                wbxml.ctag();
            }
            if (deleted.length) {
                wbxml.otag("Exceptions");
                for (let exception of deleted) {
                    wbxml.otag("Exception");
                    wbxml.atag("ExceptionStartTime", exception.date.getInTimezone(cal.UTC()).icalString);
                    wbxml.atag("Deleted", "1");
                    wbxml.ctag();
                }
                wbxml.ctag();
            }
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

        //Description, should be done at the very end (page switch)
        let description = (item.hasProperty("description")) ? tbSync.encode_utf8(item.getProperty("description")) : "";
        if (asversion == "2.5") {
            wbxml.atag("Body", description);
        } else {
            wbxml.switchpage("AirSyncBase");
            wbxml.otag("Body");
                wbxml.atag("Type", "1");
                wbxml.atag("EstimatedDataSize", "" + description.length);
                wbxml.atag("Data", description);
            wbxml.ctag();
            //does not work with horde at the moment
            if (tbSync.db.getAccountSetting(syncdata.account, "horde") == "0") wbxml.atag("NativeBodyType", "1");

            //return to Calendar code page
            wbxml.switchpage("Calendar");
        }


        //TRANSP / BusyStatus
        wbxml.atag("BusyStatus", tbSync.eas.calendarsync.getItemPropertyWithFallback(item, "TRANSP", "X-EAS-BusyStatus", this.MAP_TB_TRANSP, this.MAP_EAS_BUSYSTATUS));
        
        //CLASS / Sensitivity
        wbxml.atag("Sensitivity", tbSync.eas.calendarsync.getItemPropertyWithFallback(item, "CLASS", "X-EAS-Sensitivity", this.MAP_TB_CLASS, this.MAP_EAS_SENSITIVITY));
        
        //for simplicity, we always send a value for AllDayEvent
        wbxml.atag("AllDayEvent", (item.startDate.isDate && item.endDate.isDate) ? "1" : "0");
 
        //EAS Reminder (TB getAlarms) - at least with zarafa blanking by omitting works
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

        //return to AirSync code page
        wbxml.switchpage("AirSync");
        return wbxml.getBytes();
    }
}
